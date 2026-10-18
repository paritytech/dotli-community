// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRecentIds } from './parts.js';

describe('recent ids', () => {
  it('As a transport, I remember only my latest ids up to the limit, and an id added again counts as new', () => {
    // Given
    const recent = createRecentIds(2);
    recent.add(1);
    recent.add(2);

    // When
    recent.add(1);
    recent.add(3);
    recent.add(4);
    recent.delete(4);

    // Then
    expect([1, 2, 3, 4].map(id => recent.has(id))).toEqual([false, false, true, false]);
  });
});
