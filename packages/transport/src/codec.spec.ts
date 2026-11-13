// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Tuple, u8 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { codec } from './codec.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

describe('codec', () => {
  it('As a schema author, I decode my payload after other fields and my decode gets exactly the rest of the input', () => {
    // Given
    const message = Tuple(u8, text);
    const bytes = message.enc([7, 'tail']);

    // When
    const decoded = message.dec(bytes);

    // Then
    expect([...bytes]).toEqual([7, 0x74, 0x61, 0x69, 0x6c]);
    expect(decoded).toEqual([7, 'tail']);
  });

  it('As a schema author, I throw from my decode and the library rethrows my own error', () => {
    // Given
    const thrown = new RangeError('not a note');
    const broken = codec<string>(
      () => new Uint8Array(0),
      () => {
        throw thrown;
      },
    );

    // When
    const caught = catchError(() => broken.dec(new Uint8Array([1])));

    // Then
    expect(caught).toBe(thrown);
  });
});
