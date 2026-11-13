// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import { createNetworkMonitorState, type NetworkMonitor } from './networkMonitorState.js';
import { createNetworkHealthState } from './networkHealthState.js';
import { buildChainActivity } from '../testing/buildChainActivity.js';
import { getRelayGenesis } from '../testing/getRelayGenesis.js';
import {
  createFakePage,
  createManualTimers,
  type FakePage,
  type ManualTimers,
  resetAllStoresForTests as resetStores,
} from '@dotli/shared/testing';

type HealthMonitor = Pick<NetworkMonitor, 'version' | 'getChainClocks'>;

/** Every chain is connectable, so only what the monitor hears decides the health. */
let monitor: NetworkMonitor;
let page: FakePage;
let timers: ManualTimers;
let health: ReturnType<typeof createNetworkHealthState>;

beforeEach(() => {
  timers = createManualTimers();
  page = createFakePage();
  monitor = createNetworkMonitorState({ isConnectable: () => true, timers });
  health = createNetworkHealthState({ timers });
});

afterEach(() => {
  resetStores();
});

describe('The network health store', () => {
  it('As a user, I start using every chain and see syncing until each delivers a block, then ok', () => {
    // Given
    startHealth();

    // When
    useAll();
    const inUse = health.store.get();
    blockAll(100);

    // Then
    expect([inUse, health.store.get()]).toEqual(['idle', 'ok']);
  });

  it('As a user whose chains stop producing blocks, I wait and see degraded without any new event', async () => {
    // Given
    startHealth();
    useAll();
    blockAll(100);

    // When
    await timers.advance(getEveryChainOverdueMs());

    // Then
    expect(health.store.get()).toBe('warn');
  });

  it('As a user, I get a later block and see the health recheck when the fastest chain is overdue from that block', async () => {
    // Given
    startHealth();
    useAll();
    const fastest = Math.min(...getActiveChainRoles().map(role => role.blockTimeMs));
    const overdue = fastest * 3;
    blockAll(100);

    // When a block arrives later, moving the overdue time, and the clock reaches it and then passes it
    await timers.advance(1000);
    blockAll(101);
    await timers.advance(overdue - 1);
    const justBefore = health.store.get();
    await timers.advance(2);

    // Then
    expect([justBefore, health.store.get()]).toEqual(['ok', 'warn']);
  });

  it('As a user in another tab, I come back to the tab and see the health rechecked only then', async () => {
    // Given
    startHealth();
    useAll();
    blockAll(100);

    // When
    page.setVisibility('hidden');
    await timers.advance(getEveryChainOverdueMs());
    const pendingWhileHidden = timers.countPending();
    const whileHidden = health.store.get();
    page.setVisibility('visible');

    // Then
    expect({ pendingWhileHidden, whileHidden, shown: health.store.get() }).toEqual({
      pendingWhileHidden: 0,
      whileHidden: 'ok',
      shown: 'warn',
    });
  });

  it('As a user before any chain exists, I go offline and back and see each at once', () => {
    // Given
    startHealth();

    // When
    page.setOnline(false);
    const offline = health.store.get();
    page.setOnline(true);

    // Then
    expect([offline, health.store.get()]).toEqual(['err', 'quiet']);
  });

  it('As a user who went offline while the page booted, I wait for the network health to start and see it turn red', () => {
    // Given a page that went offline before the health started
    page.setOnline(false);

    // When
    startHealth();

    // Then
    expect(health.store.get()).toBe('err');
  });

  it('As a user, I see a frame chain drop from ready back to connecting and the health turn unstable', () => {
    // Given
    startHealth();
    monitor.recordChainPhase('relay', 'ready');

    // When
    monitor.recordChainPhase('relay', 'connecting');

    // Then
    expect(health.store.get()).toBe('warn');
  });

  it('As a user leaving the page, I stop the health store and it leaves its monitor with no listener', () => {
    // Given
    const stop = startHealth();
    const listenersWhileRunning = monitor.version.lc;

    // When
    stop();
    useAll();
    blockAll(100);

    // Then: no listener is left, and later blocks change nothing
    expect({ listenersWhileRunning, listenersAfterStop: monitor.version.lc, health: health.store.get() }).toEqual({
      listenersWhileRunning: 1,
      listenersAfterStop: 0,
      health: 'quiet',
    });
  });

  it('As a user whose only live chain is released, I wait past its recheck and the indicator never turns unstable', async () => {
    // Given
    startHealth();
    const relay = getRelayGenesis();
    monitor.recordChainActivity(buildChainActivity({ genesisHash: relay }));
    monitor.recordBestBlock(relay, 100);
    const live = health.store.get();

    // When
    monitor.recordChainActivity(buildChainActivity({ genesisHash: relay, held: false }));
    await timers.advance(60_000);

    // Then
    expect({ live, released: health.store.get(), pending: timers.countPending() }).toEqual({
      live: 'ok',
      released: 'quiet',
      pending: 0,
    });
  });

  it('As a store reset during a follow, I end the follow and leave the health quiet', () => {
    // Given
    startHealth();
    useAll();
    blockAll(100);

    // When the stores reset, and the chains go on
    resetStores();
    useAll();
    blockAll(101);

    // Then
    expect({ health: health.store.get(), pending: timers.countPending() }).toEqual({ health: 'quiet', pending: 0 });
  });
});

/** Starts the health over `on`, on a page whose visibility and connectivity the test sets. */
function startHealth(on: HealthMonitor = monitor): () => void {
  return health.start({
    monitor: on,
    page: {
      isHidden: () => page.document.hidden,
      isOnline: () => page.window.onLine,
      visibility: page.document,
      connectivity: page.window,
    },
  });
}

/** Returns a wait after a block past which every active chain's next block is overdue. Never throws. */
function getEveryChainOverdueMs(): number {
  const slowest = Math.max(...getActiveChainRoles().map(role => role.blockTimeMs));
  return slowest * 3 + 2000;
}

function useAll(): void {
  for (const role of getActiveChainRoles()) {
    monitor.recordChainActivity(buildChainActivity({ genesisHash: role.genesis }));
  }
}

function blockAll(blockNumber: number): void {
  for (const role of getActiveChainRoles()) {
    monitor.recordBestBlock(role.genesis, blockNumber);
  }
}
