// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainBar } from './chain.js';
import { describeChainHealth, type ChainHealthFacts } from './chainHealth.js';

// A 6 s chain, read as stalled after 60 s with no block.
const CHAIN = {
  reachable: true,
  state: 'live',
  bars: [],
  blockTimeMs: 6000,
  sinceLast: 0,
  phase: null,
} satisfies Parameters<typeof describeChainHealth>[0];

const FACTS: ChainHealthFacts = { sinceRead: 0, behind: false, offline: false, unreachable: false };

/** Bars numbered from 100, each landing the given gap after the block before it. */
function buildBarsWithGaps(gaps: number[]): ChainBar[] {
  return gaps.map((gapMs, i) => ({ number: 100 + i, health: 'onTime', gapMs }));
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
    const chain = { ...CHAIN, state: 'unused' as const, bars: buildBarsWithGaps([6000, 6000]) };

    // When
    const health = describeChainHealth(chain, FACTS);

    // Then
    expect(health).toEqual({ mark: { kind: 'unused' }, status: { text: 'Not in use', tone: null }, pending: null });
  });

  it.each([
    { phase: null, text: 'Connecting' },
    { phase: 'ready', text: 'Connecting' },
    { phase: 'syncing', text: 'Syncing' },
  ])(
    'As a user of a chain still coming up whose light client reports $phase, I see "$text" and a ghost bar',
    ({ phase, text }) => {
      // Given
      const chain = { ...CHAIN, state: 'pending' as const, sinceLast: null, phase };

      // When
      const health = describeChainHealth(chain, FACTS);

      // Then
      expect(health).toMatchObject({
        mark: { kind: 'connecting' },
        status: { text, tone: null },
        pending: { phase: 'searching' },
      });
    },
  );

  it('As a user back after a pause, I see a chain with bars from before as Connecting until the monitor has it live', () => {
    // Given
    const chain = { ...CHAIN, state: 'pending' as const, sinceLast: null, bars: buildBarsWithGaps([6000, 6000]) };

    // When
    const health = describeChainHealth(chain, FACTS);

    // Then
    expect(health).toEqual({ mark: { kind: 'connecting' }, status: { text: 'Connecting', tone: null }, pending: null });
  });

  it.each(['connecting', 'syncing'])(
    'As a user of a live chain whose light client reports %s again, I see it coming up',
    phase => {
      // Given
      const chain = { ...CHAIN, phase, bars: buildBarsWithGaps([6000, 6000]) };

      // When
      const health = describeChainHealth(chain, FACTS);

      // Then
      expect(health.mark).toEqual({ kind: 'connecting' });
    },
  );

  it('As a user of a live chain with one block and no bar yet, I see it Connected while its ghost bar counts on', () => {
    // Given
    const chain = { ...CHAIN, sinceLast: 1500, phase: 'ready' };

    // When
    const health = describeChainHealth(chain, { ...FACTS, sinceRead: 1000 });

    // Then
    expect(health).toEqual({
      mark: { kind: 'healthy' },
      status: { text: 'Connected', tone: null },
      pending: { phase: 'counting', heightPercent: 68, text: 'Next block in about 4s' },
    });
  });

  it('As an offline user of a chain waiting for its first block, I see no ghost bar to wait on', () => {
    // Given
    const chain = { ...CHAIN, state: 'pending' as const };

    // When
    const health = describeChainHealth(chain, { ...FACTS, offline: true });

    // Then
    expect(health.pending).toBeNull();
  });

  it.each([
    { gaps: [6000], text: 'Connected' },
    { gaps: [6000, 6000], text: 'Connected · Live 100% · Block ~6s' },
    { gaps: [60_000, 6000, 6000], text: 'Connected · Live 100% · Block ~6s' },
  ])(
    'As a user of a chain whose blocks landed $gaps ms apart, I see "$text" from its last two intervals',
    ({ gaps, text }) => {
      // Given
      const chain = { ...CHAIN, bars: buildBarsWithGaps(gaps) };

      // When
      const health = describeChainHealth(chain, FACTS);

      // Then
      expect(health).toEqual({ mark: { kind: 'healthy' }, status: { text, tone: null }, pending: null });
    },
  );

  it.each([
    { sinceLast: 59_000, sinceRead: 999, kind: 'healthy' },
    { sinceLast: 59_000, sinceRead: 1000, kind: 'outage' },
  ])(
    'As a user of a chain $sinceLast ms after its last block and $sinceRead ms after the read, I see the $kind mark',
    ({ sinceLast, sinceRead, kind }) => {
      // Given
      const chain = { ...CHAIN, sinceLast, bars: buildBarsWithGaps([6000, 6000]) };

      // When
      const health = describeChainHealth(chain, { ...FACTS, sinceRead });

      // Then
      expect(health.mark.kind).toBe(kind);
    },
  );

  it.each([
    { behind: false, tone: null },
    { behind: true, tone: 'warn' },
  ])(
    'As a user of a chain with no block for 60 s, when the verdict names it is $behind I see it not producing blocks',
    ({ behind, tone }) => {
      // Given
      const chain = { ...CHAIN, sinceLast: 60_000, bars: buildBarsWithGaps([6000, 6000]) };

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

  it.each([4000, 0])(
    'As a user of a chain whose last blocks landed %i ms apart, I see Live 100% and its own block time',
    gapMs => {
      // Given
      const chain = { ...CHAIN, bars: buildBarsWithGaps([gapMs, gapMs]) };

      // When
      const health = describeChainHealth(chain, FACTS);

      // Then
      expect(health).toEqual({
        mark: { kind: 'healthy' },
        status: { text: 'Connected · Live 100% · Block ~6s', tone: null },
        pending: null,
      });
    },
  );

  it.each([
    { blockMs: 7000, mark: { kind: 'healthy' } },
    { blockMs: 12_000, mark: { kind: 'short', share: 0.5, band: 'plain' } },
    { blockMs: 15_000, mark: { kind: 'short', share: 0.4, band: 'warn' } },
    { blockMs: 30_000, mark: { kind: 'short', share: 0.2, band: 'err' } },
  ])(
    'As a user of a 6 s chain whose last two blocks each took $blockMs ms, I see the $mark.kind mark',
    ({ blockMs, mark }) => {
      // Given
      const chain = { ...CHAIN, bars: buildBarsWithGaps([blockMs, blockMs]) };

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
      const chain = { ...CHAIN, bars: buildBarsWithGaps([7000, 8000]) };

      // When
      const health = describeChainHealth(chain, { ...FACTS, behind });

      // Then
      expect(health.status).toEqual(status);
    },
  );

  it('As a user of a slow chain far short of blocks, I see its block time in minutes and seconds', () => {
    // Given a 6.5 s chain whose last two blocks each took 65 s
    const chain = { ...CHAIN, blockTimeMs: 6500, bars: buildBarsWithGaps([65_000, 65_000]) };

    // When
    const health = describeChainHealth(chain, FACTS);

    // Then
    expect(health.status.text).toBe('Connected · Live 10% · Block ~1m 5s');
  });
});
