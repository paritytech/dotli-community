// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toMessageBytes } from './messageBytes.js';

describe('toMessageBytes', () => {
  it("As the transport, I mark bytes as a method's message and get the same bytes back", () => {
    // Given
    const bytes = Uint8Array.of(0, 4, 0x61);

    // When
    const message = toMessageBytes(bytes);

    // Then
    expect(message).toBe(bytes);
  });
});
