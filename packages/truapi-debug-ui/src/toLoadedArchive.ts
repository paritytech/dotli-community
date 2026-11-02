// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ArchiveFiles } from '@dotli/content';
import type { ArchiveFile } from './previewFile.js';

export type ArchiveRead =
  | { status: 'loading' }
  | { status: 'loaded'; files: readonly ArchiveFile[]; total: number }
  | { status: 'failed'; reason: string };

export type LoadedArchive = Extract<ArchiveRead, { status: 'loaded' }>;

/** A product's files as the Archive tab lists them, sorted by path, with their total size. Never throws. */
export function toLoadedArchive(files: ArchiveFiles): LoadedArchive {
  const list = Object.entries(files)
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { status: 'loaded', files: list, total: list.reduce((sum, file) => sum + file.bytes.length, 0) };
}
