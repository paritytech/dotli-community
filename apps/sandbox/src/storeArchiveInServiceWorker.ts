// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { packArchive, type ArchiveFiles } from '@dotli/content';

import { handOverArchive, type ArchiveWorker } from './handOverArchive.js';
import { SANDBOX_ERRORS } from './errors.js';

type Params = {
  /**
   * The page's service worker container, `null` in a browser without service workers. Its controller takes the
   * handoff.
   */
  container: { controller: ArchiveWorker | null } | null;
  /** The archive's files, by path. */
  files: ArchiveFiles;
  /** The path the page is written at. */
  pagePath: string;
};

/**
 * Hands `files` to the worker that controls the page. Before document.write(), or sub-resource requests fall through
 * to nginx's HTML fallback. Rejects with `SW_NOT_CONTROLLING` when no worker controls the page, since the page written
 * without one cannot load its files, and with the handoff's own error when the worker refuses or never acknowledges the
 * archive.
 */
export async function storeArchiveInServiceWorker({ container, files, pagePath }: Params): Promise<void> {
  const worker = container?.controller ?? null;
  if (!worker) {
    throw new Error(SANDBOX_ERRORS.SW_NOT_CONTROLLING);
  }

  await handOverArchive({ worker, archive: packArchive(files), pagePath });
}
