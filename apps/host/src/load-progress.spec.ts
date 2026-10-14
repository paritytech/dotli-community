// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { enableDotliDebugBuffering, watchDotliDebugEvents, type DotliDebugEvent } from '@dotli/truapi-debug';
import type { LoadingPhase } from './loading-controller.js';
import {
  startLoadProgress,
  type ChainDetailFacts,
  type ContentProgressFacts,
  type LoadProgress,
} from './load-progress.js';
import type { ChainSyncFacts } from './resolution-trace.js';
import { setProductLoaded } from './runtime/state/product.js';
import { networkMonitor } from './state/network-monitor.js';

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

// Each load has its own flow, since an earlier test's subscription to the product store outlives it.
let flows = 0;

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
  trace: {
    chainSync: ReturnType<typeof vi.fn>;
    chainDetail: ReturnType<typeof vi.fn>;
    bytes: ReturnType<typeof vi.fn>;
    content: ReturnType<typeof vi.fn>;
    warningShown: ReturnType<typeof vi.fn>;
  };
  debug: DotliDebugEvent[];
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
  const trace = {
    chainSync: vi.fn(),
    chainDetail: vi.fn(),
    bytes: vi.fn(),
    content: vi.fn(),
    warningShown: vi.fn(),
  };
  const flowId = `flow-${String(++flows)}`;
  const debug: DotliDebugEvent[] = [];
  onTestFinished(
    watchDotliDebugEvents(event => {
      if ('layer' in event && event.flowId === flowId) {
        debug.push(event);
      }
    }),
  );
  const progress = startLoadProgress({
    label: 'doom',
    backend,
    flowId,
    events: {
      onChainSync: chainSync.on,
      onChainDetail: chainDetail.on,
      onNetBytes: netBytes.on,
      onContentProgress: content.on,
    },
    loading,
    trace,
  });
  return { progress, chainSync, chainDetail, netBytes, content, loading, trace, debug };
}

function bands(phases: LoadingPhase[] | undefined): string[] {
  return (phases ?? []).map(phase => phase.stage);
}

describe('startLoadProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAllStoresForTests();
    enableDotliDebugBuffering();
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
    chainDetail.send({ chain: 'assethub', dbCache: 'hit' });
    netBytes.send({ received: 2048 });
    content.send({ bytesFetched: 10, totalBytes: 100 });
    vi.advanceTimersByTime(10_000);

    // Then
    expect(trace.chainSync).toHaveBeenCalledWith({ chain: 'relay', syncKind: 'connecting' });
    expect(trace.chainDetail).toHaveBeenCalledWith({ chain: 'assethub', dbCache: 'hit' });
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
    const { chainSync, loading, debug } = setup('smoldot-direct');

    // When
    chainSync.send({ chain: 'relay', syncKind: 'warpSyncProgress', at: 50, target: 100 });
    chainSync.send({ chain: 'relay', syncKind: 'warpSyncFinished' });
    chainSync.send({ chain: 'assethub', syncKind: 'firstPeer' });
    chainSync.send({ chain: 'assethub', syncKind: 'bootstrapComplete' });
    chainSync.send({ chain: 'bulletin', syncKind: 'peers', peers: 3 });

    // Then
    expect(loading.nudgePhaseProgress.mock.calls).toEqual([
      [0.5, 'relay'],
      [1, 'relay'],
    ]);
    expect(loading.advancePhase.mock.calls).toEqual([[0], [1], [2]]);
    expect(loading.releasePhaseProgress).toHaveBeenCalledTimes(1);
    const chains = networkMonitor.getNetworkStatus();
    expect(chains.find(chain => chain.key === 'relay')?.phase).toBe('ready');
    expect(chains.find(chain => chain.key === 'assethub')?.phase).toBe('ready');
    expect(chains.find(chain => chain.key === 'bulletin')?.peers).toBe(3);
    expect(debug.map(event => event.event)).toEqual(['phase', 'phase', 'phase', 'peers']);
  });

  it('As a visitor in direct mode, I see the download fill its band by bytes and hand over to preparing once complete', () => {
    // Given
    const { content, loading } = setup('smoldot-direct');

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
    expect(networkMonitor.getTransfer()).toMatchObject({ fetched: 100, total: 100 });
  });

  it('As a developer with the debug panel, I see byte totals stop once the product is on screen, the last total included', () => {
    // Given
    const { netBytes, debug } = setup('smoldot-direct');
    netBytes.send({ received: 100 });
    netBytes.send({ received: 200 });

    // When
    setProductLoaded('doom', 'doom.dot');
    vi.advanceTimersByTime(5_000);
    netBytes.send({ received: 300 });

    // Then
    expect(debug.filter(event => event.event === 'bytes').map(event => event.payload)).toEqual([
      { received: 100 },
      { received: 200 },
    ]);
  });
});
