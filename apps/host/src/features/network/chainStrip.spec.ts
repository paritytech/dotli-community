// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  describeBlockDelay,
  describePeers,
  HISTORY_SLOTS,
  landedBars,
  pendingBar,
  sameBars,
  slotOpacity,
} from './chainStrip.js';

const RELAY = { blockTimeMs: 6000, phase: null };

describe('slotOpacity', () => {
  it('As a user reading the history, the oldest slot is half strength and the newest full', () => {
    // When / Then
    expect(slotOpacity(0)).toBe('0.50');
    expect(slotOpacity(HISTORY_SLOTS - 1)).toBe('1.00');
  });
});

describe('describeBlockDelay', () => {
  it.each([
    { gapMs: 6000, said: '6.0s, on time' },
    { gapMs: 12_000, said: '12s, 6.0s late' },
  ])('As a user hovering a block that came after $gapMs ms of a 6s block time, it reads "$said"', ({ gapMs, said }) => {
    // When
    const delay = describeBlockDelay(gapMs, 6000);

    // Then
    expect(delay).toBe(said);
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
    expect(landedBars([], bars(101, 102))).toBe(0);
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

  it('As a user of a chain at or past its block time, the ghost bar stands full and says due any moment, never zero', () => {
    // When
    const bars = [pendingBar(RELAY, 6000), pendingBar(RELAY, 19_000)];

    // Then
    expect(bars).toEqual([
      { phase: 'due', heightPercent: 100, text: 'due any moment' },
      { phase: 'due', heightPercent: 100, text: 'due any moment' },
    ]);
  });
});

describe('describePeers', () => {
  it.each([
    { peers: 0, chip: { text: '0 peers', tone: 'warn', label: 'Polkadot: 0 peers connected' } },
    { peers: 1, chip: { text: '1 peer', tone: 'mono', label: 'Polkadot: 1 peer connected' } },
    { peers: 4, chip: { text: '4 peers', tone: 'mono', label: 'Polkadot: 4 peers connected' } },
  ])('As a user of a chain with $peers peers, its chip says $chip.text in the $chip.tone tone', ({ peers, chip }) => {
    // When
    const shown = describePeers('Polkadot', peers);

    // Then
    expect(shown).toEqual(chip);
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
