// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createSide } from './createSide.js';

describe('side', () => {
  it('As a product frame, I release one hold early, and ending the side runs only the holds still kept', () => {
    // Given
    const released: string[] = [];
    const side = createSide();
    const releaseEarly = side.hold(() => {
      released.push('early');
    });
    side.hold(() => {
      released.push('kept');
    });

    // When
    releaseEarly();
    side.end();

    // Then
    expect(released).toEqual(['early', 'kept']);
  });
});
