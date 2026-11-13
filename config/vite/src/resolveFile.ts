// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import {
  ASSETS_PREFIX,
  BUILD_INFO_FILE,
  getRootPage,
  isSessionPath,
  SERVICE_WORKER_PATHS,
  SHELL_FILE,
  type Route,
} from './siteRoutes.ts';

/** A file a local server sends. */
export type ResolvedFile = {
  /** The file's path on disk. */
  file: string;
  /** The path its caching headers follow. */
  pathname: string;
};

type Params = {
  /** The build's folder. */
  dir: string;
  /** The build and host the request reached. */
  route: Route;
  /** The request's path in the build, still percent-encoded. */
  pathname: string;
  /** Whether a path on disk is a file. Defaults to asking the disk. */
  isFile?: (path: string) => boolean;
};

const SESSION_FILE = 'session.html';

/** Missing, these are a 404 rather than the shell, which a browser would try to run. */
const NO_FALLBACK: ReadonlySet<string> = new Set([...SERVICE_WORKER_PATHS, `/${BUILD_INFO_FILE}`]);

/**
 * Returns the file that answers `pathname` from the build in `dir`, or `undefined` for a 404. Never throws. The first
 * of: the root page at `/`, the file itself, a folder's index on the bare host, then the shell. On the bare host each of
 * the session paths answers with the session page, which the host build never serves under its own file name. A
 * missing asset, worker, session window or version file is a 404 instead.
 */
export function resolveFile({ dir, route, pathname, isFile = isFileOnDisk }: Params): ResolvedFile | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape names no file.
    return undefined;
  }
  if (decoded === '/') {
    const page = getRootPage(route);
    const file = join(dir, page);
    return isFile(file) ? { file, pathname: `/${page}` } : undefined;
  }
  if (isSessionPath(route, pathname)) {
    const file = join(dir, SESSION_FILE);
    return isFile(file) ? { file, pathname: decoded } : undefined;
  }
  // The leading slash makes `normalize` settle `..` against the root, so no path leaves `dir`.
  const normalized = normalize(`/${decoded}`);
  // The session window's built file is served only under its paths, since those are what refuse framing. Compared
  // whatever its case, since a disk that ignores case, as macOS does, finds the file under any spelling.
  if (route.site === 'host' && normalized.toLowerCase() === `/${SESSION_FILE}`) {
    return undefined;
  }
  const file = join(dir, normalized);
  if (isFile(file)) {
    return { file, pathname: decoded };
  }
  if (decoded.startsWith(ASSETS_PREFIX) || NO_FALLBACK.has(decoded)) {
    return undefined;
  }
  if (route.bare) {
    const index = join(file, 'index.html');
    if (isFile(index)) {
      return { file: index, pathname: decoded };
    }
  }
  const shell = join(dir, SHELL_FILE);
  return isFile(shell) ? { file: shell, pathname: `/${SHELL_FILE}` } : undefined;
}

function isFileOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing, or a name the platform refuses, such as one holding a null byte.
    return false;
  }
}
