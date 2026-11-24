// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getDayLabel, startsDay } from './messageDays.js';

// Local times, so the cases hold in any time zone.
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

const NOW = at(2026, 11, 24, 9);

describe('message days', () => {
  it('As a reader, I see a day divider above the oldest message and where a new calendar day starts', () => {
    // Given
    const lateNight = { timestamp: at(2026, 11, 23, 23, 59) };
    const pastMidnight = { timestamp: at(2026, 11, 24, 0, 1) };
    const morning = { timestamp: at(2026, 11, 24, 9) };

    // When
    const starts = [
      startsDay(lateNight, undefined),
      startsDay(pastMidnight, lateNight),
      startsDay(morning, pastMidnight),
    ];

    // Then
    expect(starts).toEqual([true, true, false]);
  });

  it('As a reader, I see today and yesterday named by the calendar day, not by the hours since', () => {
    // When
    const labels = [getDayLabel(at(2026, 11, 24, 0, 1), NOW), getDayLabel(at(2026, 11, 23, 23, 59), NOW)];

    // Then
    expect(labels).toEqual(['Today', 'Yesterday']);
  });

  it('As a reader, I see an older day by its date, with the year only when it is not this one', () => {
    // When
    const thisYear = getDayLabel(at(2026, 11, 20), NOW);
    const lastYear = getDayLabel(at(2025, 11, 20), NOW);

    // Then
    expect([thisYear.includes('20'), thisYear.includes('2026')]).toEqual([true, false]);
    expect(lastYear).toContain('2025');
  });
});
