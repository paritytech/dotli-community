// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatSize } from '@dotli/shared';
import { formatCount } from './model/formatCount.js';
import type { LoadedArchive } from './toLoadedArchive.js';

/** The archive's file count and total size, as `2 files · 16 B`. Never throws. */
export function formatArchiveSummary(archive: LoadedArchive): string {
  const count = archive.files.length;
  return `${formatCount(count, 'file')} · ${formatSize(archive.total)}`;
}
