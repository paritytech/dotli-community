// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainStatus } from '../src/network-monitor.js';
import { healthTone, judgeNetworkHealth } from '../src/network-health.js';

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
    expect(judgeNetworkHealth([chain()], false)).toBe('offline');
  });

  it('As a user whose chains all produce blocks on time, I see ok', () => {
    expect(judgeNetworkHealth([chain(), chain({ role: 'assethub', label: 'Hub' })], true)).toBe('ok');
  });

  it('As a user while the chains start or connect, I see syncing', () => {
    expect(judgeNetworkHealth([], true)).toBe('syncing');
    expect(judgeNetworkHealth([chain({ latest: null, sinceLast: null })], true)).toBe('syncing');
    expect(
      judgeNetworkHealth([chain(), chain({ role: 'assethub', label: 'Hub', latest: null, sinceLast: null })], true),
    ).toBe('syncing');
  });

  it('As a user whose chain is past three block times without a block, I see degraded', () => {
    expect(judgeNetworkHealth([chain({ sinceLast: 18_001 })], true)).toBe('degraded');
  });

  it('As the capsule, I colour each verdict with its status tone', () => {
    expect(healthTone('ok')).toBe('ok');
    expect(healthTone('syncing')).toBe('idle');
    expect(healthTone('degraded')).toBe('warn');
    expect(healthTone('offline')).toBe('err');
  });
});
