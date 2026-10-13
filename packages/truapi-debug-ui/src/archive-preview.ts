// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the Archive tab shows for a product's files, apart from the view so it is tested without a DOM.

import { isEncrypted, type ArchiveFiles } from '@dotli/content';

export interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
}

export type ArchiveRead =
  | { status: 'loading' }
  | { status: 'loaded'; files: readonly ArchiveFile[]; total: number }
  | { status: 'failed'; reason: string };

export type LoadedArchive = Extract<ArchiveRead, { status: 'loaded' }>;

export type Preview = { kind: 'encrypted' } | { kind: 'image' } | { kind: 'text'; text: string } | { kind: 'binary' };

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

export function imageType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : IMAGE_TYPES[path.slice(dot + 1).toLowerCase()];
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function preview(file: ArchiveFile): Preview {
  if (isEncrypted(file.bytes)) {
    return { kind: 'encrypted' };
  }
  if (imageType(file.path) !== undefined) {
    return { kind: 'image' };
  }
  const text = decodeText(file.bytes);
  return text === null ? { kind: 'binary' } : { kind: 'text', text };
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${String(size)} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function toFiles(files: ArchiveFiles): LoadedArchive {
  const list = Object.entries(files)
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { status: 'loaded', files: list, total: list.reduce((sum, file) => sum + file.bytes.length, 0) };
}

export function summaryLabel(archive: LoadedArchive): string {
  const count = archive.files.length;
  return `${String(count)} ${count === 1 ? 'file' : 'files'} · ${formatBytes(archive.total)}`;
}
