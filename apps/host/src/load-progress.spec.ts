// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import type { LoadingPhase } from './loading-controller.js';
import { chainRoleForKey } from './chain-roles.js';
import {
  startLoadProgress,
  type ChainDetailFacts,
  type ContentProgressFacts,
  type LoadProgress,
} from './load-progress.js';
import type { ChainSyncFacts } from './resolution-trace.js';

/** A report source the test sends on, as the protocol client and the content fetch would. */
function source<T>(): { on: (listener: (event: T) => void) => () => void; send: (event: T) => void } {
  const listeners = new Set<(event: T) => void>();
  return {
    on: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: event => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

function productState(): {
  store: { get: () => { status: string }; subscribe: (listener: () => void) => () => void };
  set: (status: string) => void;
} {
  let status = 'loading';
  const listeners = new Set<() => void>();
  return {
    store: {
      get: () => ({ status }),
      subscribe: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set: next => {
      status = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

function setup(backend: Backend): {
  progress: LoadProgress;
  chainSync: ReturnType<typeof source<ChainSyncFacts>>;
  chainDetail: ReturnType<typeof source<ChainDetailFacts>>;
  netBytes: ReturnType<typeof source<{ received: number }>>;
  content: ReturnType<typeof source<ContentProgressFacts>>;
  loading: {
    initPhases: ReturnType<typeof vi.fn<(phases: LoadingPhase[]) => void>>;
    setLoadingDomain: ReturnType<typeof vi.fn<(domain: string) => void>>;
    advancePhase: ReturnType<typeof vi.fn<(index: number) => void>>;
    nudgePhaseProgress: ReturnType<typeof vi.fn<(fraction: number, stage: 'relay' | 'content') => void>>;
    releasePhaseProgress: ReturnType<typeof vi.fn<() => void>>;
    setLoadingStage: ReturnType<typeof vi.fn<(stage: 'preparing') => void>>;
    setLoadingWarning: ReturnType<typeof vi.fn<(message: string) => void>>;
    onProgressStall: ReturnType<typeof vi.fn<(listener: () => void) => void>>;
    stopStatusTick: ReturnType<typeof vi.fn<() => void>>;
  };
  monitor: {
    recordChainPhase: ReturnType<typeof vi.fn>;
    recordPeerCount: ReturnType<typeof vi.fn>;
    recordTransfer: ReturnType<typeof vi.fn>;
  };
  trace: {
    chainSync: ReturnType<typeof vi.fn>;
    chainDetail: ReturnType<typeof vi.fn>;
    bytes: ReturnType<typeof vi.fn>;
    content: ReturnType<typeof vi.fn>;
    warningShown: ReturnType<typeof vi.fn>;
  };
  debug: DotliDebugEvent[];
  product: ReturnType<typeof productState>;
} {
  const chainSync = source<ChainSyncFacts>();
  const chainDetail = source<ChainDetailFacts>();
  const netBytes = source<{ received: number }>();
  const content = source<ContentProgressFacts>();
  const loading = {
    initPhases: vi.fn<(phases: LoadingPhase[]) => void>(),
    setLoadingDomain: vi.fn<(domain: string) => void>(),
    advancePhase: vi.fn<(index: number) => void>(),
    nudgePhaseProgress: vi.fn<(fraction: number, stage: 'relay' | 'content') => void>(),
    releasePhaseProgress: vi.fn<() => void>(),
    setLoadingStage: vi.fn<(stage: 'preparing') => void>(),
    setLoadingWarning: vi.fn<(message: string) => void>(),
    onProgressStall: vi.fn<(listener: () => void) => void>(),
    stopStatusTick: vi.fn<() => void>(),
  };
  const monitor = { recordChainPhase: vi.fn(), recordPeerCount: vi.fn(), recordTransfer: vi.fn() };
  const trace = {
    chainSync: vi.fn(),
    chainDetail: vi.fn(),
    bytes: vi.fn(),
    content: vi.fn(),
    warningShown: vi.fn(),
  };
  const debug: DotliDebugEvent[] = [];
  const product = productState();
  const progress = startLoadProgress({
    label: 'doom',
    backend,
    flowId: 'flow-1',
    events: {
      onChainSync: chainSync.on,
      onChainDetail: chainDetail.on,
      onNetBytes: netBytes.on,
      onContentProgress: content.on,
    },
    loading,
    monitor,
    trace,
    emit: event => {
      debug.push(event);
    },
    chainRole: chainRoleForKey,
    product: product.store,
  });
  return { progress, chainSync, chainDetail, netBytes, content, loading, monitor, trace, debug, product };
}

function bands(phases: LoadingPhase[] | undefined): string[] {
  return (phases ?? []).map(phase => phase.stage);
}

describe('startLoadProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a visitor on the per-tab light client, I see four bands open on the first, and the download counts its bytes', () => {
    // Given
    const { loading } = setup('smoldot-direct');

    // Then
    const phases = loading.initPhases.mock.calls[0]?.[0];
    expect(bands(phases)).toEqual(['starting', 'assetHub', 'resolving', 'content']);
    expect(phases?.[0]?.label).toBe('Starting');
    expect(phases?.[3]?.reportsProgress).toBe(true);
    expect(loading.setLoadingDomain).toHaveBeenCalledWith('doom');
    expect(loading.advancePhase.mock.calls).toEqual([[0]]);
  });

  it('As a visitor on the shared light client, I see the worker start and the download runs on the clock', () => {
    // Given
    const { loading } = setup('smoldot-shared-worker');

    // Then
    const phases = loading.initPhases.mock.calls[0]?.[0];
    expect(phases?.[0]?.label).toBe('Starting Worker');
    expect(phases?.[3]?.reportsProgress).toBe(false);
  });

  it('As a visitor on a light client, I see resolver milestones move the bar, the bar hold once the name resolves, and the download take the last band', () => {
    // Given
    const { progress, loading } = setup('smoldot-shared-worker');

    // When
    progress.resolvePhase('asset-hub-connecting');
    progress.resolvePhase('asset-hub-syncing');
    progress.resolvePhase('resolving-content');
    progress.nameResolved();
    const heldAfterResolve = loading.stopStatusTick.mock.calls.length;
    progress.contentFetch();

    // Then
    expect(loading.advancePhase.mock.calls).toEqual([[0], [1], [1], [2], [3]]);
    expect(heldAfterResolve).toBe(1);
  });

  it('As a visitor on a gateway, I see three bands that resolver milestones leave alone, and the download takes the third', () => {
    // Given
    const { progress, loading } = setup('rpc-gateway');

    // When
    progress.resolvePhase('asset-hub-syncing');
    progress.contentFetch();

    // Then
    expect(bands(loading.initPhases.mock.calls[0]?.[0])).toEqual(['relay', 'resolving', 'content']);
    expect(loading.advancePhase.mock.calls).toEqual([[0], [2]]);
  });

  it('As a visitor on a gateway, I see no chain warnings, while the resolution trace still hears every report', () => {
    // Given
    const { chainSync, chainDetail, netBytes, content, loading, trace, debug } = setup('rpc-gateway');

    // When
    chainSync.send({ chain: 'relay', syncKind: 'connecting' });
    chainDetail.send({ chain: 'asset-hub', dbCache: 'hit' });
    netBytes.send({ received: 2048 });
    content.send({ bytesFetched: 10, totalBytes: 100 });
    vi.advanceTimersByTime(10_000);

    // Then
    expect(trace.chainSync).toHaveBeenCalledWith({ chain: 'relay', syncKind: 'connecting' });
    expect(trace.chainDetail).toHaveBeenCalledWith({ chain: 'asset-hub', dbCache: 'hit' });
    expect(trace.bytes).toHaveBeenCalledWith(2048);
    expect(trace.content).toHaveBeenCalledWith(10, 100);
    expect(debug.map(event => event.event)).toEqual(['dbcache']);
    expect(loading.setLoadingWarning).not.toHaveBeenCalled();
    expect(loading.nudgePhaseProgress).not.toHaveBeenCalled();
  });

  it('As a visitor in direct mode, I am told a chain finds no peers only once the load is old enough to be slow', () => {
    // Given
    const { chainSync, loading, trace } = setup('smoldot-direct');
    chainSync.send({ chain: 'relay', syncKind: 'peers', peers: 0 });

    // When
    chainSync.send({ chain: 'relay', syncKind: 'connecting' });
    vi.advanceTimersByTime(3_000);
    const warnedEarly = loading.setLoadingWarning.mock.calls.length;
    vi.advanceTimersByTime(2_000);

    // Then
    expect(warnedEarly).toBe(0);
    expect(loading.setLoadingWarning.mock.calls).toEqual([
      ['Still looking for computers that carry Polkadot. Nothing has answered yet.'],
    ]);
    expect(trace.warningShown).toHaveBeenCalledTimes(1);
  });

  it('As a visitor in direct mode, I see the bar follow Asset Hub and the relay warp, and the network monitor follows each chain', () => {
    // Given
    const { chainSync, loading, monitor, debug } = setup('smoldot-direct');

    // When
    chainSync.send({ chain: 'relay', syncKind: 'warpSyncProgress', at: 50, target: 100 });
    chainSync.send({ chain: 'relay', syncKind: 'warpSyncFinished' });
    chainSync.send({ chain: 'asset-hub', syncKind: 'firstPeer' });
    chainSync.send({ chain: 'asset-hub', syncKind: 'bootstrapComplete' });
    chainSync.send({ chain: 'bulletin', syncKind: 'peers', peers: 3 });

    // Then
    expect(loading.nudgePhaseProgress.mock.calls).toEqual([
      [0.5, 'relay'],
      [1, 'relay'],
    ]);
    expect(loading.advancePhase.mock.calls).toEqual([[0], [1], [2]]);
    expect(loading.releasePhaseProgress).toHaveBeenCalledTimes(1);
    expect(monitor.recordChainPhase.mock.calls).toEqual([
      ['relay', 'syncing'],
      ['relay', 'ready'],
      ['assethub', 'ready'],
    ]);
    expect(monitor.recordPeerCount).toHaveBeenCalledWith('bulletin', 3);
    expect(debug.map(event => event.event)).toEqual(['phase', 'phase', 'phase', 'peers']);
  });

  it('As a visitor in direct mode, I see the download fill its band by bytes and hand over to preparing once complete', () => {
    // Given
    const { content, loading, monitor } = setup('smoldot-direct');

    // When
    content.send({ bytesFetched: 0, totalBytes: null });
    content.send({ bytesFetched: 50, totalBytes: 100 });
    content.send({ bytesFetched: 100, totalBytes: 100 });

    // Then
    expect(loading.releasePhaseProgress).toHaveBeenCalledTimes(1);
    expect(loading.nudgePhaseProgress.mock.calls).toEqual([
      [0.5, 'content'],
      [1, 'content'],
    ]);
    expect(loading.setLoadingStage.mock.calls).toEqual([['preparing']]);
    expect(monitor.recordTransfer).toHaveBeenCalledWith({ fetched: 100, total: 100 });
  });

  it('As a developer with the debug panel, I see byte totals stop once the product is on screen, the last total included', () => {
    // Given
    const { netBytes, product, debug } = setup('smoldot-direct');
    netBytes.send({ received: 100 });
    netBytes.send({ received: 200 });

    // When
    product.set('loaded');
    vi.advanceTimersByTime(5_000);
    netBytes.send({ received: 300 });

    // Then
    expect(debug.filter(event => event.event === 'bytes').map(event => event.payload)).toEqual([
      { received: 100 },
      { received: 200 },
    ]);
  });
});
