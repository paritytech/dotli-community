// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainClock } from './state/networkMonitorState.js';
import {
  describeLiveNetwork,
  getNextOverdueAt,
  judgeNetworkHealth,
  type LiveVerdict,
  type NetworkHealth,
} from './networkVerdict.js';

describe('The network health verdict', () => {
  it.each<{ story: string; chains: ChainClock[]; online: boolean; expected: NetworkHealth }>([
    { story: 'offline after the chains last reported', chains: [createChain()], online: false, expected: 'err' },
    { story: 'offline with no chain reported', chains: [], online: false, expected: 'err' },
    {
      story: 'whose chains in use all produce blocks on time',
      chains: [createChain(), createChain({ label: 'Hub' })],
      online: true,
      expected: 'ok',
    },
    { story: 'with no chain in use and nothing pending', chains: [], online: true, expected: 'quiet' },
    {
      story: 'with only a chain nobody uses',
      chains: [createChain({ state: 'unused', latest: null, sinceLast: null })],
      online: true,
      expected: 'quiet',
    },
    {
      story: 'while a chain in use connects',
      chains: [createChain({ state: 'pending', latest: null, sinceLast: null })],
      online: true,
      expected: 'idle',
    },
    {
      story: 'while the frame syncs one of two chains in use',
      chains: [createChain(), createChain({ label: 'Hub', state: 'pending', latest: null })],
      online: true,
      expected: 'idle',
    },
    {
      story: 'beside a chain nobody uses that is far behind',
      chains: [createChain(), createChain({ label: 'Hub', state: 'unused', sinceLast: 60_000 })],
      online: true,
      expected: 'ok',
    },
    {
      story: 'whose chain in use is past three block times without a block',
      chains: [createChain({ sinceLast: 18_001 })],
      online: true,
      expected: 'warn',
    },
    {
      story: 'whose chain stalled or dropped back to connecting',
      chains: [createChain({ alarm: true, latest: null, sinceLast: null })],
      online: true,
      expected: 'warn',
    },
  ])('As a user $story, I look at the network health and see $expected', ({ chains, online, expected }) => {
    // When
    const health = judgeNetworkHealth(chains, online);

    // Then
    expect(health).toBe(expected);
  });
});

describe('The network menu verdict', () => {
  it.each<{ story: string; chains: ChainClock[]; expected: LiveVerdict }>([
    {
      story: 'whose chains in use all produce blocks',
      chains: [createChain(), createChain({ label: 'Hub' })],
      expected: { text: 'Your connection is good', tone: 'ok' },
    },
    {
      story: 'while one of two chains in use connects',
      chains: [createChain(), createChain({ label: 'Hub', state: 'pending', latest: null, sinceLast: null })],
      expected: { text: 'Connecting, 1 of 2 ready', tone: 'idle' },
    },
    {
      story: 'while the only chain in use connects',
      chains: [createChain({ state: 'pending', latest: null, sinceLast: null })],
      expected: { text: 'Connecting', tone: 'idle' },
    },
    {
      story: 'whose chains are overdue or stalled',
      chains: [createChain({ sinceLast: 18_001 }), createChain({ label: 'Hub', alarm: true })],
      expected: { text: 'Waiting on Relay and Hub', tone: 'warn', slow: ['Relay', 'Hub'] },
    },
    {
      story: 'with nothing in use',
      chains: [createChain({ state: 'unused' })],
      expected: { text: 'Not in use', tone: 'quiet' },
    },
  ])('As a user $story, I open the network menu and the verdict reads "$expected.text"', ({ chains, expected }) => {
    // When
    const verdict = describeLiveNetwork(chains);

    // Then
    expect(verdict).toEqual(expected);
  });
});

describe('getNextOverdueAt', () => {
  it('As a user watching the network health, I wait and only a live chain on time is due a recheck', () => {
    // Given
    const now = 50_000;

    // When
    const due = {
      onTime: getNextOverdueAt([createChain({ sinceLast: 1000 })], now),
      unusedOrAlarmed: getNextOverdueAt([createChain({ state: 'unused' }), createChain({ alarm: true })], now),
    };

    // Then
    expect(due).toEqual({ onTime: now - 1000 + 18_000, unusedOrAlarmed: null });
  });
});

function createChain(overrides: Partial<ChainClock> = {}): ChainClock {
  return {
    label: 'Relay',
    latest: 100,
    sinceLast: 1000,
    blockTimeMs: 6000,
    reachable: true,
    state: 'live',
    alarm: false,
    ...overrides,
  };
}
