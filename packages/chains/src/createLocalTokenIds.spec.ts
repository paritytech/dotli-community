// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLocalTokenIds } from './createLocalTokenIds.js';

describe('createLocalTokenIds', () => {
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
});
