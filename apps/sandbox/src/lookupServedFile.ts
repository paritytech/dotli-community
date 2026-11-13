// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The app service worker's answer to a path from an archive a page handed over.

import { getArchivePath, hasExtension } from './getArchivePath.js';
import { getMimeType } from './getMimeType.js';

/** The archive's files and the directory of the path its page is written at, replaced together by each handoff. */
export type ServedArchive = {
  files: Record<string, ArrayBuffer>;
  directory: string;
};

/**
 * The archive's answer to `pathname` at its own path, or else under the page's directory. `null` when neither, so the
 * request goes to the network.
 */
export function lookupServedFile(archive: ServedArchive, pathname: string, basePath: string): Response | null {
  return lookupArchive(archive, pathname, basePath) ?? lookupUnderPageDirectory(archive, pathname, basePath);
}

/**
 * The archive file a request means once the page's directory is read as the archive root.
 *
 * The page is written at the URL the visitor opened, so below the root a relative URL resolves under the page's
 * directory, while the archive holds every file from its root. The directory is the one the page was written at, not
 * the requester's current URL: a product's router moves its page elsewhere, and a product's worker is open at its own
 * script's path, yet both still ask for files under the written directory.
 */
function lookupUnderPageDirectory(archive: ServedArchive, pathname: string, basePath: string): Response | null {
  const { directory } = archive;
  if (directory.length <= basePath.length || !directory.startsWith(basePath) || !pathname.startsWith(directory)) {
    return null;
  }
  return lookupArchive(archive, basePath + pathname.slice(directory.length), basePath);
}

/**
 * `null` means the path is not the archive's and must reach the network: the origin also serves the shell's own
 * assets, and a 404 for them strands a refresh on the loader.
 */
function lookupArchive({ files }: ServedArchive, pathname: string, basePath: string): Response | null {
  const decoded = getArchivePath(pathname, basePath);
  if (decoded === null) {
    return null;
  }
  for (const filePath of listCandidatePaths(decoded)) {
    const content = Object.hasOwn(files, filePath) ? files[filePath] : undefined;
    if (content !== undefined) {
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': getMimeType(filePath),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        },
      });
    }
  }
  return null;
}

/**
 * The archive paths a request for `decoded` may mean, in the order they are tried: the path itself, then, without an
 * extension, its `index.html` below it and beside it, then the root `index.html` for the root itself.
 */
function listCandidatePaths(decoded: string): string[] {
  const candidates = [decoded];
  if (!hasExtension(decoded)) {
    candidates.push(decoded === '' ? 'index.html' : `${decoded}/index.html`);
    if (decoded !== '') {
      candidates.push(`${decoded}index.html`);
    }
  }
  if (decoded === '' || decoded === '/') {
    candidates.push('index.html');
  }
  return candidates;
}
