// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { packArchive } from './packArchive.js';
import type { ArchiveFiles } from './types.js';

describe('packArchive', () => {
  it('As a host handing a product to its sandbox, I pack no files and get an empty archive', () => {
    // When
    const result = packArchive({});

    // Then
    expect(result.packed.byteLength).toBe(0);
    expect(result.index).toEqual([]);
  });

  it('As a host handing a product to its sandbox, I pack several files and each index entry starts where the last ended', () => {
    // Given
    const files: ArchiveFiles = {
      'index.html': new TextEncoder().encode('<h1>A</h1>'),
      'style.css': new TextEncoder().encode('body{}'),
      'app.js': new TextEncoder().encode('console.log()'),
    };
    const expectedOffsets = [0, 10, 16];
    const expectedTotal = 29;

    // When
    const result = packArchive(files);

    // Then
    expect(result.index.map(entry => entry.o)).toEqual(expectedOffsets);
    expect(result.packed.byteLength).toBe(expectedTotal);
  });

  it('As a sandbox unpacking a product, I read a packed file back at its index entry and get its content', () => {
    // Given
    const content = 'Hello, World!';
    const files: ArchiveFiles = {
      'test.txt': new TextEncoder().encode(content),
    };

    // When
    const result = packArchive(files);
    const view = new Uint8Array(result.packed);
    const [entry] = result.index;
    if (entry === undefined) {
      throw new Error('expected an index entry');
    }
    const extracted = new TextDecoder().decode(view.slice(entry.o, entry.o + entry.l));

    // Then
    expect(extracted).toBe(content);
  });
});
