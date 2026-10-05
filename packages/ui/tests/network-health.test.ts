// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainStatus } from '../src/network-monitor.js';
import { healthWord, judgeNetworkHealth } from '../src/network-health.js';

function chain(overrides: Partial<ChainStatus> = {}): ChainStatus {
  return {
    role: 'relay',
    label: 'Relay',
    bars: [],
    latest: 100,
    sinceLast: 1000,
    blockTimeMs: 6000,
    reachable: true,
    peers: 8,
    phase: 'ready',
    ...overrides,
  };
}

describe('The network health verdict', () => {
  it('As a user offline, I see offline whatever the chains last reported', () => {
    expect(judgeNetworkHealth([chain()], false)).toBe('err');
  });

  it('As a user whose chains all produce blocks on time, I see ok', () => {
    expect(judgeNetworkHealth([chain(), chain({ role: 'assethub', label: 'Hub' })], true)).toBe('ok');
  });

  it('As a user while the chains start or connect, I see syncing', () => {
    expect(judgeNetworkHealth([], true)).toBe('idle');
    expect(judgeNetworkHealth([chain({ latest: null, sinceLast: null })], true)).toBe('idle');
    expect(
      judgeNetworkHealth([chain(), chain({ role: 'assethub', label: 'Hub', latest: null, sinceLast: null })], true),
    ).toBe('idle');
  });

  it('As a user whose chain is past three block times without a block, I see degraded', () => {
    expect(judgeNetworkHealth([chain({ sinceLast: 18_001 })], true)).toBe('warn');
  });

  it('As the More menu, I name each verdict in one word', () => {
    expect(healthWord('ok')).toBe('Connected');
    expect(healthWord('idle')).toBe('Syncing');
    expect(healthWord('warn')).toBe('Unstable');
    expect(healthWord('err')).toBe('Offline');
  });
});
