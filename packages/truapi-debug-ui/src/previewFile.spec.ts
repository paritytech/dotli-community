// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { previewFile } from './previewFile.js';

// "DOTLI_ENC\x01", the encrypted-SPA magic, then room for a salt, a nonce and a tag.
const ENCRYPTED = new Uint8Array([
  0x44,
  0x4f,
  0x54,
  0x4c,
  0x49,
  0x5f,
  0x45,
  0x4e,
  0x43,
  0x01,
  ...new Array<number>(60).fill(0),
]);

describe('archive preview', () => {
  it('As a dotli developer, I preview a text file and it shows its text', () => {
    // When
    const shown = previewFile({ path: 'index.html', bytes: new TextEncoder().encode('<h1>hi</h1>') });

    // Then
    expect(shown).toEqual({ kind: 'text', text: '<h1>hi</h1>' });
  });

  it('As a dotli developer, I preview a binary file and it reads as binary instead of text', () => {
    // Given
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff]);

    // When
    const shown = previewFile({ path: 'app.wasm', bytes });

    // Then
    expect(shown).toEqual({ kind: 'binary' });
  });

  it('As a dotli developer, I preview a file of an encrypted product and it says it is not decrypted', () => {
    // When
    const shown = previewFile({ path: 'index.html', bytes: ENCRYPTED });

    // Then
    expect(shown).toEqual({ kind: 'encrypted' });
  });

  it('As a dotli developer, I preview an image and it shows as an image of the type its extension names', () => {
    // When
    const shown = previewFile({ path: 'logo.PNG', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });

    // Then
    expect(shown).toEqual({ kind: 'image', type: 'image/png' });
  });
});
