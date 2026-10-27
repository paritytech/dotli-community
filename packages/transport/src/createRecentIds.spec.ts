// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { REMEMBERED_ENDS, createRecentIds } from './createRecentIds.js';

describe('createRecentIds', () => {
  it('As a transport, I add ids past the limit and remember only my latest, where an id added again counts as new', () => {
    // Given ids up to the limit
    const recent = createRecentIds();
    for (let id = 1; id <= REMEMBERED_ENDS; id += 1) {
      recent.add(id);
    }

    // When the first is added again, then two more, and the last is deleted
    recent.add(1);
    recent.add(REMEMBERED_ENDS + 1);
    recent.add(REMEMBERED_ENDS + 2);
    recent.delete(REMEMBERED_ENDS + 2);
    const kept = [1, 2, 3, REMEMBERED_ENDS + 1, REMEMBERED_ENDS + 2].map(id => recent.has(id));

    // Then
    expect(kept).toEqual([true, false, false, true, false]);
  });
});
