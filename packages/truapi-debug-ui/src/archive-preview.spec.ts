// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { preview, summaryLabel, toFiles } from './archive-preview.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
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
  it('As a dotli developer, the sidebar lists the archive files in order, with their count and sizes', () => {
    // When
    const archive = toFiles({ 'index.html': enc('<h1>hi</h1>'), 'assets/app.js': enc('run()') });

    // Then
    expect(archive.files.map(file => file.path)).toEqual(['assets/app.js', 'index.html']);
    expect(summaryLabel(archive)).toBe('2 files · 16 B');
  });

  it('As a dotli developer, a text file previews as its text', () => {
    // When
    const shown = preview({ path: 'index.html', bytes: enc('<h1>hi</h1>') });

    // Then
    expect(shown).toEqual({ kind: 'text', text: '<h1>hi</h1>' });
  });

  it('As a dotli developer, a binary file shows its size instead of its bytes', () => {
    // Given
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff]);

    // When
    const shown = preview({ path: 'app.wasm', bytes });

    // Then
    expect(shown).toEqual({ kind: 'binary' });
  });

  it('As a dotli developer, an encrypted product says it is not decrypted', () => {
    // When
    const shown = preview({ path: 'index.html', bytes: ENCRYPTED });

    // Then
    expect(shown).toEqual({ kind: 'encrypted' });
  });
});
