// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getActionRoom } from './getActionRoom.js';

describe('getActionRoom', () => {
  it('As a user, I lay out the bar and its actions get the pill max width less the rest of its row, the address included', () => {
    // When: a pill whose max width is 700, with a 600 px row of which the group takes 200
    const room = getActionRoom({ pillMaxWidth: 700, rowWidth: 600, groupWidth: 200 });

    // Then
    expect(room).toBe(300);
  });

  it('As a user under a pill with no max width, I lay out the bar and its actions have no room to measure against', () => {
    // When
    const room = getActionRoom({ pillMaxWidth: Number.NaN, rowWidth: 600, groupWidth: 200 });

    // Then
    expect(room).toBeUndefined();
  });
});
