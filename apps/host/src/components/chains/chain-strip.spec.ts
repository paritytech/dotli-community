// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { HISTORY_SLOTS, landedBars, pendingBar, sameBars, slideShift, slotOpacity } from './chain-strip.js';

const RELAY = { blockTimeMs: 6000, phase: null };

describe('slotOpacity', () => {
  it('As a user reading the history, the oldest slot is half strength and the newest full', () => {
    // When / Then
    expect(HISTORY_SLOTS).toBe(48);
    expect(slotOpacity(0)).toBe('0.50');
    expect(slotOpacity(47)).toBe('1.00');
  });
});

describe('the bar strip motion', () => {
  const bars = (...numbers: number[]): { number: number }[] => numbers.map(number => ({ number }));

  it('As a user watching a chain, the blocks newer than the newest shown are the ones that land', () => {
    // When / Then
    expect(landedBars(bars(101, 102), bars(101, 102, 103))).toBe(1);
    expect(landedBars(bars(101, 102), bars(102, 103, 104))).toBe(2);
  });

  it('As a user watching a chain, a re-render with the same history lands nothing', () => {
    // When / Then
    expect(landedBars(bars(101, 102), bars(101, 102))).toBe(0);
  });

  it('As a user opening the panel on a chain with history, bars in a strip that showed none appear without sliding', () => {
    // When / Then
    expect(landedBars([], bars(101))).toBe(0);
    expect(landedBars([], bars(101, 102))).toBe(0);
  });

  it('As a user watching a chain, the strip starts one bar and gap to the right per landed bar', () => {
    // When / Then
    expect(slideShift(1, 4, 2)).toBe(6);
    expect(slideShift(3, 4, 2)).toBe(18);
  });
});

describe('the ghost bar before a chain first bar', () => {
  it('As a user of a chain still connecting, the ghost bar searches, saying the light client phase or connecting', () => {
    // When
    const bars = [pendingBar(RELAY, null), pendingBar({ blockTimeMs: 6000, phase: 'syncing' }, null)];

    // Then
    expect(bars).toEqual([
      { phase: 'searching', text: 'connecting' },
      { phase: 'searching', text: 'syncing' },
    ]);
  });

  it('As a user watching a chain between blocks, the ghost bar grows and counts down to the next block', () => {
    // When
    const bar = pendingBar(RELAY, 1500);

    // Then
    expect(bar).toEqual({ phase: 'counting', heightPercent: 40, text: 'next block in about 5s' });
  });

  it('As a user of a chain past its block time, the ghost bar stands full and says due any moment, never zero', () => {
    // When
    const bars = [pendingBar(RELAY, 6000), pendingBar(RELAY, 19_000)];

    // Then
    expect(bars).toEqual([
      { phase: 'due', heightPercent: 100, text: 'due any moment' },
      { phase: 'due', heightPercent: 100, text: 'due any moment' },
    ]);
  });
});

describe('sameBars', () => {
  it('As a user watching a chain, an update that kept the same bar objects lands nothing', () => {
    // Given
    const first = { number: 1 };
    const second = { number: 2 };

    // When / Then
    expect(sameBars([first, second], [first, second])).toBe(true);
    expect(sameBars([first, second], [first, { number: 2 }])).toBe(false);
    expect(sameBars([first], [first, second])).toBe(false);
  });
});
