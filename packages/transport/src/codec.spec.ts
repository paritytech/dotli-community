// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Tuple, _void, u8 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { codec } from './codec.js';
import { request } from './request.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

describe('codec', () => {
  it('As a schema author, I wrap plain functions as a codec and the library encodes and decodes through them', () => {
    // Given
    const wrapped = text;

    // When
    const bytes = wrapped.enc('hello');
    const decoded = wrapped.dec(bytes);

    // Then
    expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
    expect(decoded).toBe('hello');
  });

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

  it("As a schema author, I decode a method's message and my decode gets exactly the payload bytes", () => {
    // Given
    const seen: number[][] = [];
    const recording = request({
      request: codec<string>(
        value => new TextEncoder().encode(value),
        payload => {
          seen.push([...payload]);
          return 'seen';
        },
      ),
      response: _void,
    });

    // When
    const message = recording.message.dec(Uint8Array.of(0, 0x61, 0x62));

    // Then
    expect(message).toEqual({ tag: 'request', value: 'seen' });
    expect(seen).toEqual([[0x61, 0x62]]);
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
