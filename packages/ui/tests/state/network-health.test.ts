// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import {
  recordBestBlock,
  recordChainActivity,
  recordChainPhase,
  resetNetworkMonitor,
} from '../../src/network-monitor.js';
import { initNetworkHealth, networkHealthStore } from '../../src/state/network-health.js';
import { resetStores } from '../helpers/solid.js';
import type * as ProtocolModule from '@dotli/protocol';

vi.mock('@dotli/protocol', async importOriginal => ({
  ...(await importOriginal<typeof ProtocolModule>()),
  isRemoteChainConnectable: () => true,
}));

const relay = (): string => getActiveChainRoles()[0]?.genesis ?? '';

function useAll(): void {
  for (const role of getActiveChainRoles()) {
    recordChainActivity({ genesisHash: role.genesis, consumers: 1, status: 'connected', following: true });
  }
}

function blockAll(blockNumber: number): void {
  for (const role of getActiveChainRoles()) {
    recordBestBlock(role.genesis, blockNumber);
  }
}

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetNetworkMonitor();
});

afterEach(() => {
  stop?.();
  stop = null;
  resetStores();
  resetNetworkMonitor();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('The network health store', () => {
  it('As a user, I see syncing until every chain in use delivers a block, then ok', () => {
    // Given
    stop = initNetworkHealth();

    // When
    useAll();

    // Then
    expect(networkHealthStore.get()).toBe('idle');

    // When
    blockAll(100);

    // Then
    expect(networkHealthStore.get()).toBe('ok');
  });

  it('As a user whose chains stop producing blocks, I see degraded without any new event', () => {
    // Given
    stop = initNetworkHealth();
    useAll();
    blockAll(100);
    const slowest = Math.max(...getActiveChainRoles().map(role => role.blockTimeMs));

    // When
    vi.advanceTimersByTime(slowest * 3 + 2000);

    // Then
    expect(networkHealthStore.get()).toBe('warn');
  });

  it('As a user, the health rechecks once, when the first chain would be overdue, and a block moves that one recheck', () => {
    // Given
    stop = initNetworkHealth();
    useAll();

    // Then: before any block nothing can fall overdue
    expect(vi.getTimerCount()).toBe(0);

    // When
    blockAll(100);

    // Then
    expect(vi.getTimerCount()).toBe(1);

    // When
    vi.advanceTimersByTime(1000);
    blockAll(101);

    // Then
    expect(vi.getTimerCount()).toBe(1);
    expect(networkHealthStore.get()).toBe('ok');
  });

  it('As a user in another tab, the health is not rechecked until the tab shows again', () => {
    // Given
    stop = initNetworkHealth();
    useAll();
    blockAll(100);
    const slowest = Math.max(...getActiveChainRoles().map(role => role.blockTimeMs));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    // When
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(slowest * 3 + 2000);

    // Then
    expect(vi.getTimerCount()).toBe(0);
    expect(networkHealthStore.get()).toBe('ok');

    // When
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));

    // Then
    expect(networkHealthStore.get()).toBe('warn');
  });

  it('As a user going offline and back, I see it at once, even before any chain exists', () => {
    // Given
    stop = initNetworkHealth();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    // When
    window.dispatchEvent(new Event('offline'));

    // Then
    expect(networkHealthStore.get()).toBe('err');

    // When
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user before any app holds a chain, I see quiet', () => {
    // When
    stop = initNetworkHealth();

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user loading a product, the frame syncing a chain shows syncing, and ready with nothing in use shows quiet', () => {
    // Given
    stop = initNetworkHealth();

    // When
    recordChainPhase('relay', 'syncing');

    // Then
    expect(networkHealthStore.get()).toBe('idle');

    // When
    recordChainPhase('relay', 'ready');

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user, a frame chain that was ready and drops back to connecting shows unstable', () => {
    // Given
    stop = initNetworkHealth();
    recordChainPhase('relay', 'ready');

    // When
    recordChainPhase('relay', 'connecting');

    // Then
    expect(networkHealthStore.get()).toBe('warn');
  });

  it('As a user whose only live chain is released, an armed recheck never turns the indicator unstable', () => {
    // Given
    stop = initNetworkHealth();
    recordChainActivity({ genesisHash: relay(), consumers: 1, status: 'connected', following: true });
    recordBestBlock(relay(), 100);
    expect(networkHealthStore.get()).toBe('ok');

    // When
    recordChainActivity({ genesisHash: relay(), consumers: 0, status: 'connected', following: false });
    vi.advanceTimersByTime(60_000);

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
    expect(vi.getTimerCount()).toBe(0);
  });
});
