// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatListCounts } from './formatListCounts.js';

describe('formatListCounts()', () => {
  it.each([
    { total: 1, dropped: 0, shown: 1, expected: { total: '1 event', dropped: null, shown: null } },
    { total: 3, dropped: 0, shown: 3, expected: { total: '3 events', dropped: null, shown: null } },
    { total: 3, dropped: 2, shown: 3, expected: { total: '3 events', dropped: '(+2 dropped)', shown: null } },
    { total: 3, dropped: 0, shown: 1, expected: { total: '3 events', dropped: null, shown: '· 1 shown' } },
  ])(
    'As a developer using the debug panel, I read the counts and see the total in the singular for one event, and the dropped and shown counts only when they differ from the total ($expected.total, $expected.dropped, $expected.shown)',
    ({ total, dropped, shown, expected }) => {
      // When
      const counts = formatListCounts({ total, dropped, shown });

      // Then
      expect(counts).toEqual(expected);
    },
  );
});
