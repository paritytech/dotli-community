// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeNetworkStatus, needsCountdown } from './chainsFormat.js';
import type { LiveVerdict } from '../../networkVerdict.js';

describe('describeNetworkStatus under a light client', () => {
  it('As a user with a good connection, the caption counts the chains in sync', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-direct');

    // Then
    expect(line).toEqual({
      tone: 'ok',
      title: 'Your connection is good',
      detail: 'Light client is in sync on all four chains',
    });
  });

  it('As a user with ten chains, the count is written in digits', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 10, 'smoldot-direct');

    // Then
    expect(line.detail).toBe('Light client is in sync on all 10 chains');
  });

  it('As a user while the chains connect, the caption says peers are being found', () => {
    // Given
    const health: LiveVerdict = { tone: 'idle' };

    // When
    const line = describeNetworkStatus(health, false, 3, 'smoldot-direct');

    // Then
    expect(line).toEqual({ tone: 'idle', title: 'Syncing', detail: 'Finding peers. This takes a few seconds.' });
  });

  it('As a user with two stalled chains, the caption names them', () => {
    // Given
    const health: LiveVerdict = { tone: 'warn', slow: ['Hub', 'Identity'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-direct');

    // Then
    expect(line).toEqual({
      tone: 'warn',
      title: 'Connection is unstable',
      detail: 'Hub and Identity are behind',
    });
  });

  it('As a user with one stalled chain, the caption says "is"', () => {
    // Given
    const health: LiveVerdict = { tone: 'warn', slow: ['Hub'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-direct');

    // Then
    expect(line.detail).toBe('Hub is behind');
  });

  it('As a user who went offline, the menu says so whatever the chains last reported', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, true, 4, 'smoldot-direct');

    // Then
    expect(line).toEqual({ tone: 'err', title: 'You are offline', detail: 'No peers on any chain. Retrying.' });
  });

  it('As a user with two chains, the caption says both rather than counting them', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 2, 'smoldot-direct');

    // Then
    expect(line.detail).toBe('Light client is in sync on both chains');
  });

  it("As a user on the shared-worker light client, the captions are the light client's", () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-shared-worker');

    // Then
    expect(line.detail).toBe('Light client is in sync on all four chains');
  });

  it("As a user whose settings are not read yet, I open the network menu and see the light client's captions", () => {
    // Given
    const verdict: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(verdict, false, 4);

    // Then
    expect(line.detail).toBe('Light client is in sync on all four chains');
  });
});

describe('describeNetworkStatus under trusted providers', () => {
  it('As a user on trusted providers with a good connection, the caption claims no light client', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 4, 'rpc-gateway');

    // Then
    expect(line).toEqual({ tone: 'ok', title: 'Your connection is good', detail: 'Served by trusted providers' });
  });

  it('As a user on trusted providers while the chains connect, the caption speaks of providers, not peers', () => {
    // Given
    const health: LiveVerdict = { tone: 'idle' };

    // When
    const line = describeNetworkStatus(health, false, 3, 'rpc-gateway');

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
    const line = describeNetworkStatus(health, false, 4, 'rpc-gateway');

    // Then
    expect(line).toEqual({ tone: 'warn', title: 'Connection is unstable', detail: 'Hub and Identity are behind' });
  });

  it('As a user on trusted providers with one stalled chain, the caption says "is"', () => {
    // Given
    const health: LiveVerdict = { tone: 'warn', slow: ['Hub'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'rpc-gateway');

    // Then
    expect(line.detail).toBe('Hub is behind');
  });

  it('As a user on trusted providers who went offline, the caption speaks of providers, not peers', () => {
    // Given
    const health: LiveVerdict = { tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, true, 4, 'rpc-gateway');

    // Then
    expect(line).toEqual({
      tone: 'err',
      title: 'You are offline',
      detail: 'Trusted providers are out of reach. Retrying.',
    });
  });
});

describe('describeNetworkStatus with nothing in use', () => {
  it('As a user whose app holds no chain, the menu says none is in use', () => {
    // Given
    const verdict: LiveVerdict = { tone: 'quiet' };

    // When
    const line = describeNetworkStatus(verdict, false, 0, 'smoldot-direct');

    // Then
    expect(line).toEqual({
      tone: 'quiet',
      title: 'No chains in use',
      detail: 'Chains appear here once the app connects to them.',
    });
  });

  it('As a user with no chain in use, I go offline and the menu says I am offline, not that none is in use', () => {
    // Given
    const verdict: LiveVerdict = { tone: 'quiet' };

    // When
    const line = describeNetworkStatus(verdict, true, 0, 'smoldot-direct');

    // Then
    expect(line).toEqual({ tone: 'err', title: 'You are offline', detail: 'No peers on any chain. Retrying.' });
  });
});

/** A chain in use, between its blocks unless told otherwise. */
const waiting = {
  reachable: true,
  state: 'live' as const,
  bars: [] as { number: number; health: 'onTime'; gapMs: number }[],
  sinceLast: 1000 as number | null,
};

describe('the network panel countdown', () => {
  it('As a user watching a chain between blocks, the countdown runs', () => {
    // When
    const runs = needsCountdown([waiting]);

    // Then
    expect(runs).toBe(true);
  });

  it('As a user, the countdown stops once no chain is waiting for its first block', () => {
    // Given
    const landed = { ...waiting, bars: [{ number: 11, health: 'onTime' as const, gapMs: 6000 }], sinceLast: 0 };

    // When
    const runs = needsCountdown([landed]);

    // Then
    expect(runs).toBe(false);
  });

  it('As a user, a chain still connecting, unreachable or not in use runs no countdown', () => {
    // Given
    const chains = [
      { ...waiting, sinceLast: null },
      { ...waiting, reachable: false },
      { ...waiting, state: 'unused' as const },
    ];

    // When
    const runs = chains.map(chain => needsCountdown([chain]));

    // Then
    expect(runs).toEqual([false, false, false]);
    expect(needsCountdown([])).toBe(false);
  });
});
