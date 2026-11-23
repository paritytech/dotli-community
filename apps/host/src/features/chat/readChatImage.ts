// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The wire declares no type, so the bytes say what they are. Fetched bytes may be SVG and inline bytes may not, which
// keeps a run-time picture from carrying markup.

import type { ImageSource } from '@parity/truapi';
import { fromHex } from '@dotli/shared';
import { ImageUnavailableError } from './imageUnavailableError.js';

/** The types a custom message's image may draw as. */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

/** An image's bytes and the type they were recognised as. */
export type LoadedImage = { bytes: Uint8Array; type: ImageType };

/** A source the host fetches, from Bulletin or the product's archive. */
export type FetchedImageSource = Exclude<ImageSource, { tag: 'Inline' }>;

/**
 * Reads a fetched source's bytes, each checked against its hash. Rejects with `ImageUnavailableError`, and with the
 * signal's reason once `signal` aborts.
 */
export type ProductImageRead = (source: FetchedImageSource, signal: AbortSignal) => Promise<Uint8Array>;

// The wire caps an inline image.
const INLINE_MAX_BYTES = 64 * 1024;
// One Bulletin blob, which no image a host draws exceeds.
const FETCHED_MAX_BYTES = 2 * 1024 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50];
// An SVG document names its root within its first bytes, after an XML declaration, comments or a doctype.
const SVG_SNIFF_BYTES = 1024;
const SVG_ROOT = /^(?:\s|<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>]/i;

/**
 * Resolves `source`'s bytes and type: inline bytes from the tree, else through `read`. Rejects with
 * `ImageUnavailableError` for bytes over their source's cap or of a type it may not carry, with what `read` rejects
 * with, and with the signal's reason once `signal` aborts.
 */
export async function readChatImage(
  source: ImageSource,
  read: ProductImageRead,
  signal: AbortSignal,
): Promise<LoadedImage> {
  switch (source.tag) {
    case 'Inline':
      return checkImage(fromHex(source.value), { maxBytes: INLINE_MAX_BYTES, svg: false });
    case 'Bulletin':
    case 'Archive':
      return checkImage(await read(source, signal), { maxBytes: FETCHED_MAX_BYTES, svg: true });
  }
}

function checkImage(bytes: Uint8Array, { maxBytes, svg }: { maxBytes: number; svg: boolean }): LoadedImage {
  if (bytes.length > maxBytes) {
    throw new ImageUnavailableError(
      'too_large',
      `An image of ${String(bytes.length)} bytes is over its ${String(maxBytes)} byte cap`,
    );
  }
  const type = getImageType(bytes, svg);
  if (type === null) {
    throw new ImageUnavailableError('unsupported_type', `An image of ${String(bytes.length)} bytes has no known type`);
  }
  return { bytes, type };
}

function getImageType(bytes: Uint8Array, svg: boolean): ImageType | null {
  if (startsWith(bytes, PNG_MAGIC)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG_MAGIC)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, RIFF_MAGIC) && startsWith(bytes.subarray(8), WEBP_MAGIC)) {
    return 'image/webp';
  }
  if (svg && SVG_ROOT.test(new TextDecoder().decode(bytes.subarray(0, SVG_SNIFF_BYTES)))) {
    return 'image/svg+xml';
  }
  return null;
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);
}
