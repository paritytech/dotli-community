// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainBar } from './chain.js';
import { describeChainHealth, type ChainHealthFacts } from './chainHealth.js';

// A 6 s chain: a 60 s window of 10 predicted blocks.
const CHAIN = {
  reachable: true,
  state: 'live',
  bars: [],
  blockTimeMs: 6000,
  sinceLast: 0,
  phase: null,
} satisfies Parameters<typeof describeChainHealth>[0];

const FACTS: ChainHealthFacts = { sinceRead: 0, behind: false, offline: false, unreachable: false };

/** Bars numbered from 100, each after the gap before it. The first bar's own gap never counts toward an age. */
function buildBarsWithGaps(gaps: number[]): ChainBar[] {
  return gaps.map((gapMs, i) => ({ number: 100 + i, health: 'onTime', gapMs }));
}

/** `produced` bars over exactly one 60 s window after an anchor bar, the newest landing as the chain is read. */
function buildWindowOf(produced: number, windowMs = 60_000): ChainBar[] {
  return buildBarsWithGaps([0, ...Array.from({ length: produced }, () => windowMs / produced)]);
}

describe('describeChainHealth', () => {
  it('As a user who is offline, I see a chain with no endpoint as unavailable with no internet', () => {
    // Given
    const chain = { ...CHAIN, reachable: false };

    // When
    const health = describeChainHealth(chain, { ...FACTS, offline: true, unreachable: true });

    // Then
    expect(health).toEqual({
      mark: { kind: 'unavailable' },
      status: { text: 'No internet', tone: null },
      pending: null,
    });
  });

  it.each([
    { unreachable: true, tone: 'err' },
    { unreachable: false, tone: 'warn' },
  ])(
    'As a user of a chain unused and with no endpoint, when the network is unreachable is $unreachable I see No endpoint in $tone',
    ({ unreachable, tone }) => {
      // Given
      const chain = { ...CHAIN, reachable: false, state: 'unused' as const };

      // When
      const health = describeChainHealth(chain, { ...FACTS, unreachable });

      // Then
      expect(health).toEqual({ mark: { kind: 'unavailable' }, status: { text: 'No endpoint', tone }, pending: null });
    },
  );

  it('As a user of a chain nobody uses, I see it as not in use', () => {
    // Given
    const chain = { ...CHAIN, state: 'unused' as const, bars: buildWindowOf(10) };

    // When
    const health = describeChainHealth(chain, FACTS);

    // Then
    expect(health).toEqual({ mark: { kind: 'unused' }, status: { text: 'Not in use', tone: null }, pending: null });
  });

  it.each([
    { sinceLast: null, text: 'Connecting', pending: { phase: 'searching', text: 'Connecting' } },
    {
      sinceLast: 1500,
      text: 'Next block in about 4s',
      pending: { phase: 'counting', heightPercent: 68, text: 'Next block in about 4s' },
    },
  ])(
    'As a user of a chain in use with no bar yet, $sinceLast ms after its last block and 1 s after the read, I see it connecting with "$text"',
    ({ sinceLast, text, pending }) => {
      // Given
      const chain = { ...CHAIN, state: 'pending' as const, sinceLast };

      // When
      const health = describeChainHealth(chain, { ...FACTS, sinceRead: 1000 });

      // Then
      expect(health).toEqual({ mark: { kind: 'connecting' }, status: { text, tone: null }, pending });
    },
  );

  it('As an offline user of a chain waiting for its first block, I see no ghost bar to wait on', () => {
    // Given
    const chain = { ...CHAIN, state: 'pending' as const };

    // When
    const health = describeChainHealth(chain, { ...FACTS, offline: true });

    // Then
    expect(health.pending).toBeNull();
  });

  it.each([
    { sinceLast: 5000, sinceRead: 999, text: 'Connected' },
    { sinceLast: 5000, sinceRead: 1000, text: 'Connected · Live 90% · Block ~7s' },
    { sinceLast: null, sinceRead: 1000, text: 'Connected' },
  ])(
    'As a user of a chain whose oldest bar is 54 s before its newest, $sinceLast ms after the newest and $sinceRead ms after the read, I see "$text"',
    ({ sinceLast, sinceRead, text }) => {
      // Given
      const chain = { ...CHAIN, sinceLast, bars: buildBarsWithGaps(Array.from({ length: 10 }, () => 6000)) };

      // When
      const health = describeChainHealth(chain, { ...FACTS, sinceRead });

      // Then
      expect(health).toEqual({ mark: { kind: 'healthy' }, status: { text, tone: null }, pending: null });
    },
  );

  it.each([
    { behind: false, tone: null },
    { behind: true, tone: 'warn' },
  ])(
    'As a user of a chain with no block for a whole window, when the verdict names it is $behind I see it not producing blocks',
    ({ behind, tone }) => {
      // Given
      const chain = { ...CHAIN, sinceLast: 60_000, bars: buildWindowOf(10) };

      // When
      const health = describeChainHealth(chain, { ...FACTS, behind });

      // Then
      expect(health).toEqual({
        mark: { kind: 'outage' },
        status: { text: 'Not producing blocks', tone },
        pending: null,
      });
    },
  );

  it('As a user of a chain producing faster than predicted, I see its share capped at all of its blocks', () => {
    // Given
    const chain = { ...CHAIN, bars: buildWindowOf(20) };

    // When
    const health = describeChainHealth(chain, FACTS);

    // Then
    expect(health).toEqual({
      mark: { kind: 'healthy' },
      status: { text: 'Connected · Live 100% · Block ~6s', tone: null },
      pending: null,
    });
  });

  it.each([
    { produced: 9, mark: { kind: 'healthy' } },
    { produced: 5, mark: { kind: 'short', share: 0.5, band: 'plain' } },
    { produced: 4, mark: { kind: 'short', share: 0.4, band: 'warn' } },
    { produced: 2, mark: { kind: 'short', share: 0.2, band: 'err' } },
  ])(
    'As a user of a chain that produced $produced of 10 predicted blocks, I see the $mark.kind mark',
    ({ produced, mark }) => {
      // Given
      const chain = { ...CHAIN, bars: buildWindowOf(produced) };

      // When
      const health = describeChainHealth(chain, FACTS);

      // Then
      expect(health.mark).toEqual(mark);
    },
  );

  it.each([
    { behind: false, status: { text: 'Connected · Live 80% · Block ~8s', tone: null } },
    { behind: true, status: { text: 'Behind · Live 80% · Block ~8s', tone: 'warn' } },
  ])(
    'As a user of a chain short of blocks, when the verdict names it is $behind I see "$status.text"',
    ({ behind, status }) => {
      // Given
      const chain = { ...CHAIN, bars: buildWindowOf(8) };

      // When
      const health = describeChainHealth(chain, { ...FACTS, behind });

      // Then
      expect(health.status).toEqual(status);
    },
  );

  it('As a user of a slow chain far short of blocks, I see its block time in minutes and seconds', () => {
    // Given a 6.5 s chain, so a 65 s window of 10 predicted blocks
    const chain = { ...CHAIN, blockTimeMs: 6500, bars: buildWindowOf(1, 65_000) };

    // When
    const health = describeChainHealth(chain, FACTS);

    // Then
    expect(health.status.text).toBe('Connected · Live 10% · Block ~1m 5s');
  });
});
