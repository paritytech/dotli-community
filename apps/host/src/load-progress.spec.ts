// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { enableDotliDebugBuffering, watchDotliDebugEvents, type DotliDebugEvent } from '@dotli/truapi-debug';
import { createSyncStore } from '@dotli/shared';
import type { PageContent } from '@dotli/ui';
import { createLoadingController, type LoadingPhase } from './loading-controller.js';
import {
  startLoadProgress,
  type ChainDetailFacts,
  type ContentProgressFacts,
  type LoadingScreen,
  type LoadProgress,
} from './load-progress.js';
import type { ChainSyncFacts } from './resolution-trace.js';
import { setProductLoaded } from './runtime/state/product.js';
import { getLoadingState } from './state/loading.js';
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

/** The line the loading screen shows for its running stage, the name drawn with its TLD. */
function stepLine(): string {
  return getLoadingState()
    .step.map(part => (typeof part === 'string' ? part : `${part.host}${part.tld}`))
    .join('');
}

const progressNow = (): number => getLoadingState().progress;

function setup(backend: Backend): {
  progress: LoadProgress;
  chainSync: ReturnType<typeof source<ChainSyncFacts>>;
  chainDetail: ReturnType<typeof source<ChainDetailFacts>>;
  netBytes: ReturnType<typeof source<{ received: number }>>;
  content: ReturnType<typeof source<ContentProgressFacts>>;
  /** The bands the load gave the loading screen. */
  bands: () => LoadingPhase[];
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
  // The page's loading screen, which writes the loading store, with motion off so no typing frame is asked for.
  const controller = createLoadingController({
    reducedMotion: () => true,
    frames: { request: () => 0, cancel: () => undefined, now: () => performance.now() },
    pageContent: createSyncStore<PageContent>('load-progress-spec-page-content', 'page'),
  });
  let given: LoadingPhase[] = [];
  const loading: LoadingScreen = {
    ...controller,
    initPhases: phases => {
      given = phases;
      controller.initPhases(phases);
    },
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
  return { progress, chainSync, chainDetail, netBytes, content, bands: () => given, trace, debug };
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
    const { progress, content, bands } = setup('smoldot-direct');
    const opened = { progress: progressNow(), line: stepLine() };

    // When the download starts and a second passes with no byte counted, then half the bytes land
    progress.contentFetch();
    vi.advanceTimersByTime(1_000);
    const waiting = progressNow();
    content.send({ bytesFetched: 50, totalBytes: 100 });

    // Then
    expect(bands().map(band => band.stage)).toEqual(['starting', 'assetHub', 'resolving', 'content']);
    expect(opened).toEqual({ progress: 2, line: 'Reaching out' });
    expect(waiting).toBe(62);
    expect(progressNow()).toBe(78.5);
    expect(stepLine()).toBe('Downloading the app');
  });

  it('As a visitor on the shared light client, I see the download run on the clock', () => {
    // Given
    const { progress } = setup('smoldot-shared-worker');

    // When a second of the download passes with no byte counted
    progress.contentFetch();
    vi.advanceTimersByTime(1_000);

    // Then
    // Five crawl ticks through the 62 to 95 band, which expects ten seconds.
    expect(progressNow()).toBeCloseTo(65.3);
  });

  it('As a visitor on a light client, I see resolver milestones move the bar, the bar hold once the name resolves, and the download take the last band', () => {
    // Given
    const { progress } = setup('smoldot-shared-worker');
    const band = (): { progress: number; line: string } => ({ progress: progressNow(), line: stepLine() });

    // When
    progress.resolvePhase('asset-hub-connecting');
    const connecting = band();
    progress.resolvePhase('asset-hub-syncing');
    const syncing = band();
    progress.resolvePhase('resolving-content');
    const resolving = band();
    progress.nameResolved();
    const resolved = getLoadingState();
    vi.advanceTimersByTime(5_000);
    const held = getLoadingState();
    progress.contentFetch();

    // Then
    expect(connecting).toEqual({ progress: 10, line: 'Looking up doom.paseo' });
    expect(syncing).toEqual(connecting);
    expect(resolving).toEqual({ progress: 55, line: 'Found it' });
    expect(held).toEqual(resolved);
    expect(band()).toEqual({ progress: 62, line: 'Downloading the app' });
  });

  it('As a visitor on a gateway, I see three bands that resolver milestones leave alone, and the download takes the third', () => {
    // Given
    const { progress, bands } = setup('rpc-gateway');
    const opened = { progress: progressNow(), line: stepLine() };

    // When
    progress.resolvePhase('asset-hub-syncing');
    const afterMilestone = { progress: progressNow(), line: stepLine() };
    progress.contentFetch();

    // Then
    expect(bands().map(band => band.stage)).toEqual(['relay', 'resolving', 'content']);
    expect(opened).toEqual({ progress: 5, line: 'Connecting to Polkadot' });
    expect(afterMilestone).toEqual(opened);
    expect({ progress: progressNow(), line: stepLine() }).toEqual({ progress: 62, line: 'Downloading the app' });
  });

  it('As a visitor on a gateway, I see no chain warnings, while the resolution trace still hears every report', () => {
    // Given
    const { chainSync, chainDetail, netBytes, content, trace, debug } = setup('rpc-gateway');

    // When the relay finds no peers, and Asset Hub finds one, which would move a light client's bar
    chainSync.send({ chain: 'relay', syncKind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', syncKind: 'connecting' });
    chainSync.send({ chain: 'assethub', syncKind: 'firstPeer' });
    chainDetail.send({ chain: 'assethub', dbCache: 'hit' });
    netBytes.send({ received: 2048 });
    content.send({ bytesFetched: 10, totalBytes: 100 });
    const afterReports = progressNow();
    vi.advanceTimersByTime(10_000);

    // Then
    expect(getLoadingState().warning).toBeNull();
    expect(afterReports).toBe(5);
    expect(trace.chainSync).toHaveBeenCalledWith({ chain: 'relay', syncKind: 'connecting' });
    expect(trace.chainDetail).toHaveBeenCalledWith({ chain: 'assethub', dbCache: 'hit' });
    expect(trace.bytes).toHaveBeenCalledWith(2048);
    expect(trace.content).toHaveBeenCalledWith(10, 100);
    expect(debug.map(event => event.event)).toEqual(['dbcache']);
  });

  it('As a visitor in direct mode, I am told a chain finds no peers only once the load is old enough to be slow', () => {
    // Given
    const { chainSync, trace } = setup('smoldot-direct');
    chainSync.send({ chain: 'relay', syncKind: 'peers', peers: 0 });

    // When
    chainSync.send({ chain: 'relay', syncKind: 'connecting' });
    vi.advanceTimersByTime(3_000);
    const warnedEarly = getLoadingState().warning;
    vi.advanceTimersByTime(2_000);

    // Then
    expect(warnedEarly).toBeNull();
    expect(getLoadingState().warning).toBe(
      'Still looking for computers that carry Polkadot. Nothing has answered yet.',
    );
    expect(trace.warningShown).toHaveBeenCalledTimes(1);
  });

  it('As a visitor in direct mode, I see the bar follow the relay warp and Asset Hub, and the network monitor follows each chain', () => {
    // Given
    const { chainSync, debug } = setup('smoldot-direct');

    // When
    chainSync.send({ chain: 'relay', syncKind: 'warpSyncProgress', at: 50, target: 100 });
    const warping = progressNow();
    chainSync.send({ chain: 'relay', syncKind: 'warpSyncFinished' });
    const warped = progressNow();
    chainSync.send({ chain: 'assethub', syncKind: 'firstPeer' });
    const hubFound = { progress: progressNow(), line: stepLine() };
    chainSync.send({ chain: 'assethub', syncKind: 'bootstrapComplete' });
    chainSync.send({ chain: 'bulletin', syncKind: 'peers', peers: 3 });

    // Then: half the warp is half of the starting band, from 2 to 10
    expect(warping).toBe(6);
    expect(warped).toBe(10);
    expect(hubFound).toEqual({ progress: 10, line: 'Looking up doom.paseo' });
    expect({ progress: progressNow(), line: stepLine() }).toEqual({ progress: 55, line: 'Found it' });
    const chains = networkMonitor.getNetworkStatus();
    expect(chains.find(chain => chain.key === 'relay')?.phase).toBe('ready');
    expect(chains.find(chain => chain.key === 'assethub')?.phase).toBe('ready');
    expect(chains.find(chain => chain.key === 'bulletin')?.peers).toBe(3);
    expect(debug.map(event => event.event)).toEqual(['phase', 'phase', 'phase', 'peers']);
  });

  it('As a visitor in direct mode, I see the download fill its band by bytes and hand over to preparing once complete', () => {
    // Given
    const { progress, content } = setup('smoldot-direct');
    progress.contentFetch();

    // When
    content.send({ bytesFetched: 0, totalBytes: null });
    content.send({ bytesFetched: 50, totalBytes: 100 });
    const filling = { progress: progressNow(), line: stepLine() };
    content.send({ bytesFetched: 100, totalBytes: 100 });

    // Then
    expect(filling).toEqual({ progress: 78.5, line: 'Downloading the app' });
    expect({ progress: progressNow(), line: stepLine() }).toEqual({ progress: 95, line: 'Got everything' });
    expect(networkMonitor.getTransfer()).toMatchObject({ fetched: 100, total: 100 });
  });

  it.each([
    [
      'Bulletin finds a peer',
      (load: ReturnType<typeof setup>) => {
        load.chainSync.send({ chain: 'bulletin', syncKind: 'peers', peers: 3 });
      },
    ],
    [
      'the download declares no total',
      (load: ReturnType<typeof setup>) => {
        load.content.send({ bytesFetched: 0, totalBytes: null });
      },
    ],
  ])('As a visitor in direct mode, I see the download run on the clock once %s', (_case, release) => {
    // Given
    const load = setup('smoldot-direct');
    load.progress.contentFetch();

    // When a second of the download passes with no byte counted
    release(load);
    vi.advanceTimersByTime(1_000);

    // Then: five crawl ticks through the 62 to 95 band, where waiting on bytes would hold it at 62
    expect(progressNow()).toBeCloseTo(65.3);
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
