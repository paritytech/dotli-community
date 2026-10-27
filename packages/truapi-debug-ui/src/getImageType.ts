// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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

/** The image media type a path's extension names, or undefined for any other file. Never throws. */
export function getImageType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : IMAGE_TYPES[path.slice(dot + 1).toLowerCase()];
}
