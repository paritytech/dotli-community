// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainClock } from '../src/network-monitor.js';
import { healthWord, judgeNetworkHealth, nextOverdueAt } from '../src/network-health.js';

function chain(overrides: Partial<ChainClock> = {}): ChainClock {
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

describe('The network health verdict', () => {
  it('As a user offline, I see offline whatever the chains last reported', () => {
    expect(judgeNetworkHealth([chain()], false)).toBe('err');
    expect(judgeNetworkHealth([], false)).toBe('err');
  });

  it('As a user whose chains in use all produce blocks on time, I see ok', () => {
    expect(judgeNetworkHealth([chain(), chain({ label: 'Hub' })], true)).toBe('ok');
  });

  it('As a user with no chain in use and nothing pending, I see quiet', () => {
    expect(judgeNetworkHealth([], true)).toBe('quiet');
    expect(judgeNetworkHealth([chain({ state: 'unused', latest: null, sinceLast: null })], true)).toBe('quiet');
  });

  it('As a user while a chain in use connects, or the frame syncs one, I see syncing', () => {
    expect(judgeNetworkHealth([chain({ state: 'pending', latest: null, sinceLast: null })], true)).toBe('idle');
    expect(judgeNetworkHealth([chain(), chain({ label: 'Hub', state: 'pending', latest: null })], true)).toBe('idle');
  });

  it('As a user, a chain nobody uses never colours the verdict', () => {
    expect(judgeNetworkHealth([chain(), chain({ label: 'Hub', state: 'unused', sinceLast: 60_000 })], true)).toBe('ok');
  });

  it('As a user whose chain in use is past three block times without a block, I see degraded', () => {
    expect(judgeNetworkHealth([chain({ sinceLast: 18_001 })], true)).toBe('warn');
  });

  it('As a user whose chain stalled or dropped back to connecting, I see degraded', () => {
    expect(judgeNetworkHealth([chain({ alarm: true, latest: null, sinceLast: null })], true)).toBe('warn');
  });

  it('As the health store, only a live chain on time is due a recheck', () => {
    // Given
    const now = 50_000;

    // Then
    expect(nextOverdueAt([chain({ sinceLast: 1000 })], now)).toBe(now - 1000 + 18_000);
    expect(nextOverdueAt([chain({ state: 'unused' }), chain({ alarm: true })], now)).toBeNull();
  });

  it('As the More menu, I name each verdict in one word', () => {
    expect(healthWord('ok')).toBe('Connected');
    expect(healthWord('idle')).toBe('Syncing');
    expect(healthWord('warn')).toBe('Unstable');
    expect(healthWord('err')).toBe('Offline');
    expect(healthWord('quiet')).toBe('Not in use');
  });
});
