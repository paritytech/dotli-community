// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ImageSource } from '@parity/truapi';
import { toHex } from '@dotli/shared';
import { ImageUnavailableError } from './imageUnavailableError.js';
import { readChatImage, type ProductImageRead } from './readChatImage.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const WEBP = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38);
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>');
const TEXT = new TextEncoder().encode('hello, not an image');

const ARCHIVE_LOGO: ImageSource = { tag: 'Archive', value: 'logo.png' };

function inline(bytes: Uint8Array): ImageSource {
  return { tag: 'Inline', value: toHex(bytes) };
}

/** A product read that serves `bytes` for every fetched source. */
function serving(bytes: Uint8Array): ProductImageRead {
  return () => Promise.resolve(bytes);
}

function never(): Promise<Uint8Array> {
  return Promise.reject(new Error('An inline image read the product'));
}

async function reasonOf(loading: Promise<unknown>): Promise<string> {
  const error: unknown = await loading.catch((caught: unknown) => caught);
  if (!(error instanceof ImageUnavailableError)) {
    throw new Error('The image loaded, or failed with another error', { cause: error });
  }
  return error.reason;
}

describe('readChatImage', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['WebP', WEBP, 'image/webp'],
  ] as const)('As a user, I see an inline %s image recognised by its bytes', async (_name, bytes, type) => {
    // When
    const image = await readChatImage(inline(bytes), never, new AbortController().signal);

    // Then
    expect(image).toEqual({ bytes, type });
  });

  it('As a user, I see an SVG the product serves from its archive', async () => {
    // When
    const image = await readChatImage(ARCHIVE_LOGO, serving(SVG), new AbortController().signal);

    // Then
    expect(image.type).toBe('image/svg+xml');
  });

  it('As a user, I see an inline SVG as unavailable, since a tree carries no markup', async () => {
    // When
    const reason = await reasonOf(readChatImage(inline(SVG), never, new AbortController().signal));

    // Then
    expect(reason).toBe('unsupported_type');
  });

  it('As a user, I see fetched bytes of no image type as unavailable', async () => {
    // When
    const reason = await reasonOf(readChatImage(ARCHIVE_LOGO, serving(TEXT), new AbortController().signal));

    // Then
    expect(reason).toBe('unsupported_type');
  });

  it('As a user, I see an inline image over the wire cap as unavailable', async () => {
    // Given
    const oversized = new Uint8Array(64 * 1024 + 1);
    oversized.set(PNG);

    // When
    const reason = await reasonOf(readChatImage(inline(oversized), never, new AbortController().signal));

    // Then
    expect(reason).toBe('too_large');
  });
});
