// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLocalTokenIds } from './createLocalTokenIds.js';

describe('createLocalTokenIds', () => {
  it('As a session, I get a local token that names its number in base 36 and my session', () => {
    // Given
    const localTokenIds = createLocalTokenIds();

    // When
    const token = localTokenIds.takeNext({ sessionId: 'local:0' });

    // Then
    expect(token).toBe('token:0:local:0');
  });

  it('As the broker, I number owned tokens with one counter, so no two of them are the same', () => {
    // Given
    const localTokenIds = createLocalTokenIds();

    // When
    const tokens = [
      localTokenIds.takeNext({ sessionId: 'a' }),
      localTokenIds.takeNext({ sessionId: 'a' }),
      localTokenIds.takeNext({ sessionId: 'b' }),
      localTokenIds.takeNext({ sessionId: 'b' }),
    ];

    // Then
    expect(tokens).toEqual(['token:0:a', 'token:1:a', 'token:2:b', 'token:3:b']);
  });

  it('As the broker, I keep counting past every single base 36 digit, and the count never starts over', () => {
    // Given
    const localTokenIds = createLocalTokenIds();

    // When
    const tokens = Array.from({ length: 38 }, () => localTokenIds.takeNext({ sessionId: 's' }));

    // Then
    expect(tokens.slice(9, 11)).toEqual(['token:9:s', 'token:a:s']);
    expect(tokens.slice(35)).toEqual(['token:z:s', 'token:10:s', 'token:11:s']);
    expect(new Set(tokens).size).toBe(38);
  });
});
