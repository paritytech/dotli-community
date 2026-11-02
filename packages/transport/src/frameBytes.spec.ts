// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toFrameBytes } from './frameBytes.js';

describe('toFrameBytes', () => {
  it('As the transport, I mark bytes as a whole frame and get the same bytes back', () => {
    // Given
    const bytes = Uint8Array.of(1, 0, 0, 0, 3);

    // When
    const frame = toFrameBytes(bytes);

    // Then
    expect(frame).toBe(bytes);
  });
});
