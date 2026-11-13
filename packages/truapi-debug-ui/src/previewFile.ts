// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the Archive tab shows for a product's files, apart from the view so it is tested without a DOM.

import { isEncrypted } from '@dotli/content';
import { getImageType } from './getImageType.js';

export type ArchiveFile = {
  path: string;
  bytes: Uint8Array;
};

/** An image carries the media type its extension names. */
export type Preview =
  { kind: 'encrypted' } | { kind: 'image'; type: string } | { kind: 'text'; text: string } | { kind: 'binary' };

/** How the Archive tab shows `file`: encrypted, an image, its text, or binary. */
export function previewFile(file: ArchiveFile): Preview {
  if (isEncrypted(file.bytes)) {
    return { kind: 'encrypted' };
  }
  const type = getImageType(file.path);
  if (type !== undefined) {
    return { kind: 'image', type };
  }
  const text = decodeText(file.bytes);
  return text === null ? { kind: 'binary' } : { kind: 'text', text };
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Bytes that are not valid UTF-8 are binary, which is the answer.
    return null;
  }
}
