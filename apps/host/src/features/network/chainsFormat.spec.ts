// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeNetworkStatus, describeTransfer } from './chainsFormat.js';
import type { LiveVerdict } from './networkVerdict.js';
import type { ChainView } from './chains.js';

type StatusChain = Pick<ChainView, 'label' | 'state' | 'reachable' | 'peers'>;

describe('describeNetworkStatus under a light client', () => {
  it('As a user with a good connection, the caption counts the chains in sync', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(4), backend: 'smoldot-direct' });

    // Then
    expect(line).toEqual({
      tone: 'ok',
      title: 'Your connection is good',
      detail: 'Light client is in sync on all four chains.',
    });
  });

  it('As a user with ten chains, the count is written in digits', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({
      verdict: health,
      offline: false,
      chains: live(10),
      backend: 'smoldot-direct',
    });

    // Then
    expect(line.detail).toBe('Light client is in sync on all 10 chains.');
  });

  it('As a user while the chains connect with no peer yet, the caption says peers are being found', () => {
    // Given
    const health: LiveVerdict = { tone: 'idle' };
    const chains = [chain({ label: 'Relay', state: 'pending' }), chain({ label: 'Hub', state: 'pending', peers: 0 })];

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains, backend: 'smoldot-direct' });

    // Then
    expect(line).toEqual({ tone: 'idle', title: 'Syncing', detail: 'Connecting to peers. This takes a few seconds.' });
  });

  it('As a user whose chains found peers, the caption names the chains it waits for', () => {
    // Given
    const health: LiveVerdict = { tone: 'idle' };
    const chains = [
      chain({ label: 'Relay', state: 'pending' }),
      chain({ label: 'Hub', peers: 4 }),
      chain({ label: 'People', state: 'pending' }),
      chain({ label: 'Identity', state: 'unused', reachable: false }),
    ];

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains, backend: 'smoldot-direct' });

    // Then
    expect(line.detail).toBe('Waiting for Relay and People. This takes a few seconds.');
  });

  it('As a user with two stalled chains, the caption names them', () => {
    // Given
    const health: LiveVerdict = { tone: 'warn', slow: ['Hub', 'Identity'] };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(4), backend: 'smoldot-direct' });

    // Then
    expect(line).toEqual({
      tone: 'warn',
      title: 'Connection is unstable',
      detail: 'Hub and Identity are behind.',
    });
  });

  it('As a user with one stalled chain, the caption says "is"', () => {
    // Given
    const health: LiveVerdict = { tone: 'warn', slow: ['Hub'] };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(4), backend: 'smoldot-direct' });

    // Then
    expect(line.detail).toBe('Hub is behind.');
  });

  it('As a user who went offline, the menu says so whatever the chains last reported', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: true, chains: live(4), backend: 'smoldot-direct' });

    // Then
    expect(line).toEqual({ tone: 'err', title: 'You are offline', detail: 'No peers on any chain. Retrying.' });
  });

  it('As a user with two chains, the caption says both rather than counting them', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(2), backend: 'smoldot-direct' });

    // Then
    expect(line.detail).toBe('Light client is in sync on both chains.');
  });

  it("As a user whose settings are not read yet, I open the network menu and see the light client's captions", () => {
    // Given
    const verdict: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({ verdict: verdict, offline: false, chains: live(4), backend: undefined });

    // Then
    expect(line.detail).toBe('Light client is in sync on all four chains.');
  });
});

describe('describeNetworkStatus under trusted providers', () => {
  it('As a user on trusted providers with a good connection, the caption claims no light client', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(4), backend: 'rpc-gateway' });

    // Then
    expect(line).toEqual({ tone: 'ok', title: 'Your connection is good', detail: 'Served by trusted providers.' });
  });

  it('As a user on trusted providers while the chains connect, the caption speaks of providers, not peers', () => {
    // Given
    const health: LiveVerdict = { tone: 'idle' };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(3), backend: 'rpc-gateway' });

    // Then
    expect(line).toEqual({
      tone: 'idle',
      title: 'Syncing',
      detail: 'Reaching trusted providers. This takes a few seconds.',
    });
  });

  it('As a user on trusted providers with stalled chains, the caption says they are behind', () => {
    // Given
    const health: LiveVerdict = { tone: 'warn', slow: ['Hub', 'Identity'] };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: false, chains: live(4), backend: 'rpc-gateway' });

    // Then
    expect(line).toEqual({ tone: 'warn', title: 'Connection is unstable', detail: 'Hub and Identity are behind.' });
  });

  it('As a user on trusted providers who went offline, the caption speaks of providers, not peers', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus({ verdict: health, offline: true, chains: live(4), backend: 'rpc-gateway' });

    // Then
    expect(line).toEqual({
      tone: 'err',
      title: 'You are offline',
      detail: 'Trusted providers are out of reach. Retrying.',
    });
  });
});

describe('describeNetworkStatus with nothing in use', () => {
  it('As a user on a network with no endpoint for any chain, the menu says the network is out of reach', () => {
    // Given
    const verdict: LiveVerdict = { tone: 'unreachable' };
    const chains = [
      chain({ state: 'unused', reachable: false }),
      chain({ label: 'Hub', state: 'unused', reachable: false }),
    ];

    // When
    const line = describeNetworkStatus({ verdict, offline: false, chains, backend: 'smoldot-direct' });

    // Then
    expect(line).toEqual({
      tone: 'unreachable',
      title: "Can't reach this network",
      detail: 'It offers no endpoint for these chains.',
    });
  });

  it('As a user whose app holds no chain, the menu says none is in use', () => {
    // Given
    const verdict: LiveVerdict = { tone: 'quiet' };

    // When
    const line = describeNetworkStatus({
      verdict: verdict,
      offline: false,
      chains: live(0),
      backend: 'smoldot-direct',
    });

    // Then
    expect(line).toEqual({
      tone: 'quiet',
      title: 'No chains in use',
      detail: 'Chains appear here once the app connects to them.',
    });
  });
});

/** A live chain the network can reach, unless told otherwise. */
function chain(overrides: Partial<StatusChain> = {}): StatusChain {
  return { label: 'Relay', state: 'live', reachable: true, peers: null, ...overrides };
}

/** `count` live chains. */
function live(count: number): StatusChain[] {
  return Array.from({ length: count }, (_, i) => chain({ label: `Chain ${String(i)}` }));
}

describe('describeTransfer', () => {
  it.each([
    {
      case: 'loads the product',
      transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 },
      loading: true,
      rows: { speed: { label: 'Speed', value: '512 B/s' }, size: { label: 'Downloading', value: '2 kB / 4.0 MB' } },
    },
    {
      case: 'fetched the whole archive',
      transfer: { bytesPerSecond: 512, fetched: 3_000_000, total: 3_000_000 },
      loading: true,
      rows: { speed: { label: 'Speed', value: '512 B/s' }, size: { label: 'Size', value: '2.9 MB' } },
    },
    {
      case: 'loads from cache, with no total',
      transfer: { bytesPerSecond: 40_000, fetched: null, total: null },
      loading: true,
      rows: { speed: { label: 'Speed', value: '39 kB/s' }, size: null },
    },
    {
      case: 'has a total of zero',
      transfer: { bytesPerSecond: null, fetched: 0, total: 0 },
      loading: true,
      rows: { speed: null, size: null },
    },
    {
      case: 'has the product on screen',
      transfer: { bytesPerSecond: 800, fetched: 4096, total: 4096 },
      loading: false,
      rows: { speed: null, size: null },
    },
  ])('As a user whose page $case, the transfer footer shows what the row says', ({ transfer, loading, rows }) => {
    // When
    const shown = describeTransfer(transfer, loading);

    // Then
    expect(shown).toEqual(rows);
  });
});
