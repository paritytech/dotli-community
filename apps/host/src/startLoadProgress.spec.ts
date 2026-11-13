// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { asProductId } from '@parity/truapi';
import type { ContentProgress } from '@dotli/bitswap';
import type { Backend } from '@dotli/config';
import { createManualTimers, resetAllStoresForTests, type ManualTimers } from '@dotli/shared/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import { atom } from 'nanostores';
import type { PageContent } from '@dotli/ui';
import { createChainReporter } from './createChainReporter.js';
import { createLoadingController, type LoadingPhase } from './createLoadingController.js';
import {
  startLoadProgress,
  type LoadingScreen,
  type LoadTelemetrySources,
  type LoadProgress,
} from './startLoadProgress.js';
import { bindReports } from './testing/bindReports.js';
import { productState } from './runtime/state/productState.js';
import { loadingState } from './state/loadingState.js';
import { createManualPoll } from './testing/createManualPoll.js';
import { networkMonitorState } from './state/networkMonitorState.js';

/** A report source the test sends on, as the protocol client and the content fetch would. */
type ReportSource<Report> = {
  on: (listener: (report: Report) => void) => () => void;
  send: (report: Report) => void;
  /** Returns whether anything still listens. */
  isHeard: () => boolean;
};

/** A load's progress over a page of its own, the sources it hears and what it reported, until the case ends. */
type LoadStand = {
  progress: LoadProgress;
  timers: ManualTimers;
  chainSync: ReportSource<ChainSyncEvent>;
  chainDetail: ReportSource<ChainDetail>;
  netBytes: ReportSource<{ received: number }>;
  content: ReportSource<ContentProgress>;
  /** Returns the bands the load gave the loading screen. */
  getBands: () => LoadingPhase[];
  trace: {
    recordChainSync: Mock;
    recordChainDetail: Mock;
    recordBytes: Mock;
    recordContent: Mock;
    markWarningShown: Mock;
  };
  debug: DotliDebugEvent[];
};

/** The bar and the line the loading screen shows. */
type Band = { progress: number; line: string };

type Params = {
  /** The backend the load runs on. */
  backend: Backend;
  /** Light client report sources that stand in for the stand's own. */
  telemetry?: Partial<LoadTelemetrySources>;
};

/** The debug panel's flow every load reports under. */
const FLOW_ID = 'load-flow';

/** When the page opened, on the wall clock. */
const PAGE_OPENED_AT = Date.UTC(2026, 0, 1);

describe('startLoadProgress', () => {
  it('As a visitor on the per-tab light client, I see four bands open on the first, and the download counts its bytes', async () => {
    // Given
    const { progress, content, getBands, timers } = setupLoad({ backend: 'smoldot-direct' });
    const opened = readBand();

    // When the download starts and a second passes with no byte counted, then half the bytes land
    progress.enterContentFetch();
    await timers.advance(1_000);
    const waiting = readProgress();
    content.send({ bytesFetched: 50, totalBytes: 100, bytesPerSecond: 0 });

    // Then
    expect(getBands().map(band => band.stage)).toEqual(['starting', 'assetHub', 'resolving', 'content']);
    expect(opened).toEqual({ progress: 2, line: 'Reaching out' });
    expect(waiting).toBe(62);
    expect(readProgress()).toBe(78.5);
    expect(readStepLine()).toBe('Downloading the app');
  });

  it('As a visitor on the shared light client, I wait through the download and it runs on the clock', async () => {
    // Given
    const { progress, timers } = setupLoad({ backend: 'smoldot-shared-worker' });

    // When a second of the download passes with no byte counted
    progress.enterContentFetch();
    await timers.advance(1_000);

    // Then
    // Five crawl ticks through the 62 to 95 band, which expects ten seconds.
    expect(readProgress()).toBeCloseTo(65.3);
  });

  it('As a visitor on a light client, I see resolver milestones move the bar, the bar hold once the name resolves, and the download take the last band', async () => {
    // Given
    const { progress, timers } = setupLoad({ backend: 'smoldot-shared-worker' });

    // When
    progress.resolvePhase('asset-hub-connecting');
    const connecting = readBand();
    progress.resolvePhase('asset-hub-syncing');
    const syncing = readBand();
    progress.resolvePhase('resolving-content');
    const resolving = readBand();
    progress.markNameResolved();
    const resolved = loadingState.get();
    await timers.advance(5_000);
    const held = loadingState.get();
    progress.enterContentFetch();

    // Then
    expect(connecting).toEqual({ progress: 10, line: 'Looking up doom.paseo' });
    expect(syncing).toEqual(connecting);
    expect(resolving).toEqual({ progress: 55, line: 'Found it' });
    expect(held).toEqual(resolved);
    expect(readBand()).toEqual({ progress: 62, line: 'Downloading the app' });
  });

  it('As a visitor on a gateway, I see three bands that resolver milestones leave alone, and the download takes the third', () => {
    // Given
    const { progress, getBands } = setupLoad({ backend: 'rpc-gateway' });
    const opened = readBand();

    // When
    progress.resolvePhase('asset-hub-syncing');
    const afterMilestone = readBand();
    progress.enterContentFetch();

    // Then
    expect(getBands().map(band => band.stage)).toEqual(['relay', 'resolving', 'content']);
    expect(opened).toEqual({ progress: 5, line: 'Connecting to Polkadot' });
    expect(afterMilestone).toEqual(opened);
    expect(readBand()).toEqual({ progress: 62, line: 'Downloading the app' });
  });

  it('As a visitor on a gateway, I get chain reports and see no chain warnings while the resolution trace still hears every report', async () => {
    // Given
    const { chainSync, chainDetail, netBytes, content, trace, debug, timers } = setupLoad({ backend: 'rpc-gateway' });

    // When the relay finds no peers, and Asset Hub finds one, which would move a light client's bar
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    chainSync.send({ chain: 'assethub', kind: 'firstPeer' });
    chainDetail.send({ chain: 'assethub', dbCache: 'hit' });
    netBytes.send({ received: 2048 });
    content.send({ bytesFetched: 10, totalBytes: 100, bytesPerSecond: 0 });
    const afterReports = readProgress();
    await timers.advance(10_000);

    // Then
    expect(loadingState.get().warning).toBeNull();
    expect(afterReports).toBe(5);
    expect(trace.recordChainSync).toHaveBeenCalledWith({ chain: 'relay', kind: 'connecting' });
    expect(trace.recordChainDetail).toHaveBeenCalledWith({ chain: 'assethub', dbCache: 'hit' });
    expect(trace.recordBytes).toHaveBeenCalledWith(2048);
    expect(trace.recordContent).toHaveBeenCalledWith(10, 100);
    expect(debug.map(event => event.event)).toEqual(['dbcache']);
  });

  it('As a visitor in direct mode, I wait on a chain with no peers and am told only once the load is old enough to be slow', async () => {
    // Given
    const { chainSync, trace, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });

    // When
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(3_000);
    const warnedEarly = loadingState.get().warning;
    await timers.advance(2_000);

    // Then
    expect(warnedEarly).toBeNull();
    expect(loadingState.get().warning).toBe(
      'Still looking for computers that carry Polkadot. Nothing has answered yet.',
    );
    expect(trace.markWarningShown).toHaveBeenCalledTimes(1);
  });

  it('As a visitor in direct mode, I was told a chain has no peers, it then finds peers while it still connects, and its line says so', async () => {
    // Given the relay's line shown for a chain with no peers
    const { chainSync, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(5_000);

    // When
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 3 });

    // Then
    expect(loadingState.get().warning).toBe('Connected to 3 computers for Polkadot, but no data is arriving yet.');
  });

  it('As a visitor in direct mode, I was told a chain has no peers, it reports a stall, and its line stays', async () => {
    // Given the relay's line shown for a chain with no peers
    const { chainSync, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(5_000);
    const shown = loadingState.get().warning;

    // When
    chainSync.send({ chain: 'relay', kind: 'stalled' });

    // Then
    expect(loadingState.get().warning).toBe(shown);
  });

  it('As a visitor in direct mode, I was told a chain has no peers, it stalls and then recovers, and its line gives way', async () => {
    // Given the relay's line shown for a chain with no peers, and the relay stalling
    const { chainSync, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(5_000);
    const shown = loadingState.get().warning;
    chainSync.send({ chain: 'relay', kind: 'stalled' });

    // When
    chainSync.send({ chain: 'relay', kind: 'recovered' });

    // Then
    expect(loadingState.get().warning).not.toBe(shown);
  });

  it('As a visitor in direct mode, I wait on two chains that stall before the load is old enough to be slow and am told of the later stall at that mark', async () => {
    // Given the relay and Asset Hub find no peers, and the relay starts connecting
    const { chainSync, trace, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'assethub', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(1_000);

    // When Asset Hub starts connecting a second later, so both stall before the mark
    chainSync.send({ chain: 'assethub', kind: 'connecting' });
    await timers.advance(4_000);

    // Then
    expect(loadingState.get().warning).toBe(
      'Still looking for computers that carry the name registry. Nothing has answered yet.',
    );
    expect(trace.markWarningShown).toHaveBeenCalledTimes(1);
  });

  it('As a visitor in direct mode, I was told of the later of two stalled chains, that chain recovers while the other still stalls, and its line gives way to the general one', async () => {
    // Given the relay and Asset Hub stall before the mark, and Asset Hub's line is shown at it
    const { chainSync, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'assethub', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(1_000);
    chainSync.send({ chain: 'assethub', kind: 'connecting' });
    await timers.advance(4_000);

    // When Asset Hub finds peers and completes its boot
    chainSync.send({ chain: 'assethub', kind: 'peers', peers: 3 });
    chainSync.send({ chain: 'assethub', kind: 'bootstrapComplete' });
    await timers.advance(20_000);

    // Then
    expect(loadingState.get().warning).toBe('Still working. This is taking longer than usual.');
  });

  it('As a visitor in direct mode, I wait on two stalled chains, the later one recovers before the load is old enough to be slow, and at that mark I am told of the general slowness', async () => {
    // Given the relay and Asset Hub stall before the mark, Asset Hub's line parked last
    const { chainSync, trace, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'assethub', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    await timers.advance(1_000);
    chainSync.send({ chain: 'assethub', kind: 'connecting' });
    await timers.advance(3_500);

    // When Asset Hub completes its boot just before the mark, while the relay still stalls
    chainSync.send({ chain: 'assethub', kind: 'peers', peers: 3 });
    chainSync.send({ chain: 'assethub', kind: 'bootstrapComplete' });
    await timers.advance(500);

    // Then
    expect(loadingState.get().warning).toBe('Still working. This is taking longer than usual.');
    expect(trace.markWarningShown).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I see a report source that throws as the load progress subscribes reported as a defect, while the progress returns and leaves no other source listened to', () => {
    // Given a byte counter that cannot be listened to
    const { counted } = bindReports();
    const telemetry: Partial<LoadTelemetrySources> = {
      subscribeNetBytes() {
        throw new Error('the protocol frame is gone');
      },
    };

    // When
    const { chainSync, chainDetail } = setupLoad({ backend: 'smoldot-direct', telemetry });

    // Then
    expect(counted('load_progress.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect([chainSync.isHeard(), chainDetail.isHeard()]).toEqual([false, false]);
  });

  it('As an operator, I see an unsubscribe that throws as a failed start cleans up reported too, while the other sources are still unsubscribed', () => {
    // Given a chain sync source whose unsubscribe throws, and a byte counter that cannot be listened to
    const { counted } = bindReports();
    const telemetry: Partial<LoadTelemetrySources> = {
      subscribeChainSync: () => () => {
        throw new Error('the protocol frame is gone');
      },
      subscribeNetBytes() {
        throw new Error('the byte counter is gone');
      },
    };

    // When
    const { chainDetail } = setupLoad({ backend: 'smoldot-direct', telemetry });

    // Then both throws were reported and the chain detail source was unsubscribed
    expect(counted('load_progress.transition')).toHaveLength(2);
    expect(chainDetail.isHeard()).toBe(false);
  });

  it.each(['smoldot-direct', 'smoldot-shared-worker'] as const)(
    'As a visitor on the %s light client, I see the bar follow the relay warp and Asset Hub, and the network monitor follows each chain',
    backend => {
      // Given
      const { chainSync, debug } = setupLoad({ backend });

      // When
      chainSync.send({ chain: 'relay', kind: 'warpSyncProgress', at: 50, target: 100 });
      const warping = readProgress();
      chainSync.send({ chain: 'relay', kind: 'warpSyncFinished' });
      const warped = readProgress();
      chainSync.send({ chain: 'assethub', kind: 'firstPeer' });
      const hubFound = readBand();
      chainSync.send({ chain: 'assethub', kind: 'bootstrapComplete' });
      chainSync.send({ chain: 'bulletin', kind: 'peers', peers: 3 });
      const chains = networkMonitorState.getNetworkStatus();

      // Then: half the warp is half of the starting band, from 2 to 10
      expect(warping).toBe(6);
      expect(warped).toBe(10);
      expect(hubFound).toEqual({ progress: 10, line: 'Looking up doom.paseo' });
      expect(readBand()).toEqual({ progress: 55, line: 'Found it' });
      expect(chains.find(chain => chain.key === 'relay')?.phase).toBe('ready');
      expect(chains.find(chain => chain.key === 'assethub')?.phase).toBe('ready');
      expect(chains.find(chain => chain.key === 'bulletin')?.peers).toBe(3);
      expect(debug.map(event => event.event)).toEqual(['phase', 'phase', 'phase', 'peers']);
    },
  );

  it('As an operator in direct mode, I see the resolution trace hear the download progress before it moves the bar', () => {
    // Given a trace that reads the bar as it hears the download
    const { progress, content, trace } = setupLoad({ backend: 'smoldot-direct' });
    const barsHeard: number[] = [];
    trace.recordContent.mockImplementation(() => {
      barsHeard.push(readProgress());
    });
    progress.enterContentFetch();

    // When
    content.send({ bytesFetched: 50, totalBytes: 100, bytesPerSecond: 0 });

    // Then
    expect(barsHeard).toEqual([62]);
  });

  it('As a visitor in direct mode, I see the download fill its band by bytes and hand over to preparing once complete', () => {
    // Given
    const { progress, content } = setupLoad({ backend: 'smoldot-direct' });
    progress.enterContentFetch();

    // When
    content.send({ bytesFetched: 0, totalBytes: null, bytesPerSecond: 0 });
    content.send({ bytesFetched: 50, totalBytes: 100, bytesPerSecond: 0 });
    const filling = readBand();
    content.send({ bytesFetched: 100, totalBytes: 100, bytesPerSecond: 0 });

    // Then
    expect(filling).toEqual({ progress: 78.5, line: 'Downloading the app' });
    expect(readBand()).toEqual({ progress: 95, line: 'Got everything' });
    expect(networkMonitorState.getTransfer()).toMatchObject({ fetched: 100, total: 100 });
  });

  it.each([
    [
      'Bulletin finds a peer',
      (load: LoadStand) => {
        load.chainSync.send({ chain: 'bulletin', kind: 'peers', peers: 3 });
      },
    ],
    [
      'the download declares no total',
      (load: LoadStand) => {
        load.content.send({ bytesFetched: 0, totalBytes: null, bytesPerSecond: 0 });
      },
    ],
  ])(
    'As a visitor in direct mode, I wait through the download once %s and it runs on the clock',
    async (_case, release) => {
      // Given
      const load = setupLoad({ backend: 'smoldot-direct' });
      load.progress.enterContentFetch();

      // When a second of the download passes with no byte counted
      release(load);
      await load.timers.advance(1_000);

      // Then: five crawl ticks through the 62 to 95 band, where waiting on bytes would hold it at 62
      expect(readProgress()).toBeCloseTo(65.3);
    },
  );

  it('As a visitor on a fast connection, I wait while the download parks the bar and see no warning', async () => {
    // Given
    const { progress, netBytes, content, timers } = setupLoad({ backend: 'smoldot-direct' });
    progress.enterContentFetch();
    content.send({ bytesFetched: 500, totalBytes: 1_000, bytesPerSecond: 0 });

    // When the bar holds for ten seconds while 2 MB arrive every second
    for (let tick = 1; tick <= 20; tick++) {
      await timers.advance(500);
      netBytes.send({ received: tick * 1_000_000 });
    }

    // Then
    expect(loadingState.get().warning).toBeNull();
  });

  it('As a visitor on a slow connection, I wait while the download parks the bar and see the rate', async () => {
    // Given
    const { progress, netBytes, content, timers } = setupLoad({ backend: 'smoldot-direct' });
    progress.enterContentFetch();
    content.send({ bytesFetched: 500, totalBytes: 1_000, bytesPerSecond: 0 });

    // When the bar holds for ten seconds while 2 kB arrive every second
    for (let tick = 1; tick <= 20; tick++) {
      await timers.advance(500);
      netBytes.send({ received: tick * 1_024 });
    }

    // Then
    expect(loadingState.get().warning).toBe(
      'Still downloading at 2 kB/s. That is slower than this app usually needs, so give it a moment.',
    );
  });

  it('As a visitor whose protocol frame restarts mid-download, I see the rate it last measured, never a negative one', async () => {
    // Given 2 MB arrive every second
    const { progress, netBytes, content, timers } = setupLoad({ backend: 'smoldot-direct' });
    progress.enterContentFetch();
    content.send({ bytesFetched: 500, totalBytes: 1_000, bytesPerSecond: 0 });
    for (let tick = 1; tick <= 6; tick++) {
      await timers.advance(500);
      netBytes.send({ received: tick * 1_000_000 });
    }

    // When the new frame's byte meter starts again from zero
    await timers.advance(500);
    netBytes.send({ received: 1_000 });

    // Then
    expect(networkMonitorState.getTransfer().bytesPerSecond).toBe(2_000_000);
  });

  it('As a developer with the debug panel, I see the product on screen and byte totals stop, the last total included', async () => {
    // Given
    const { netBytes, debug, timers } = setupLoad({ backend: 'smoldot-direct' });
    netBytes.send({ received: 100 });
    netBytes.send({ received: 200 });

    // When
    productState.setLoaded({ label: 'doom', productId: asProductId('doom.dot') });
    await timers.advance(5_000);
    netBytes.send({ received: 300 });

    // Then
    expect(debug.filter(event => event.event === 'bytes').map(event => event.payload)).toEqual([
      { received: 100 },
      { received: 200 },
    ]);
  });

  it('As a developer with the debug panel, I see a load whose byte counter only reads zero reach the screen and hear no total', async () => {
    // Given a byte counter that reports its zero baseline and nothing more
    const { netBytes, debug, timers } = setupLoad({ backend: 'smoldot-direct' });
    netBytes.send({ received: 0 });
    await timers.advance(1_000);
    netBytes.send({ received: 0 });

    // When
    productState.setLoaded({ label: 'doom', productId: asProductId('doom.dot') });

    // Then
    expect(debug.filter(event => event.event === 'bytes')).toEqual([]);
  });

  it('As a developer with the debug panel, I see the product on screen before any byte total and hear no total', async () => {
    // Given
    const { debug, timers } = setupLoad({ backend: 'smoldot-direct' });

    // When
    productState.setLoaded({ label: 'doom', productId: asProductId('doom.dot') });
    await timers.advance(5_000);

    // Then
    expect(debug.filter(event => event.event === 'bytes')).toEqual([]);
  });

  it('As a developer, I dispose the load progress and hear no more of its byte totals or its chain warnings', async () => {
    // Given a relay that finds no peers, and a first byte total
    const { progress, chainSync, netBytes, debug, trace, timers } = setupLoad({ backend: 'smoldot-direct' });
    chainSync.send({ chain: 'relay', kind: 'peers', peers: 0 });
    chainSync.send({ chain: 'relay', kind: 'connecting' });
    netBytes.send({ received: 100 });

    // When
    progress.dispose();
    await timers.advance(5_000);
    netBytes.send({ received: 200 });

    // Then
    expect(loadingState.get().warning).toBeNull();
    expect(debug.filter(event => event.event === 'bytes').map(event => event.payload)).toEqual([{ received: 100 }]);
    expect(trace.recordBytes.mock.calls).toEqual([[100]]);
  });

  it('As an operator, I see an unsubscribe that throws as the load progress is disposed reported as a defect, while the sources after it are still unsubscribed', () => {
    // Given a chain detail source whose unsubscribe throws
    const { counted } = bindReports();
    const telemetry: Partial<LoadTelemetrySources> = {
      subscribeChainDetail: () => () => {
        throw new Error('the protocol frame is gone');
      },
    };
    const { progress, netBytes } = setupLoad({ backend: 'smoldot-direct', telemetry });

    // When
    progress.dispose();

    // Then
    expect(counted('load_progress.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect(netBytes.isHeard()).toBe(false);
  });

  it('As a visitor whose download parks after the load progress was disposed, I wait and see no slow-load warning', async () => {
    // Given a download that counts its bytes, parked halfway
    const { progress, content, trace, timers } = setupLoad({ backend: 'smoldot-direct' });
    progress.enterContentFetch();
    content.send({ bytesFetched: 500, totalBytes: 1_000, bytesPerSecond: 0 });

    // When
    progress.dispose();
    await timers.advance(10_000);

    // Then
    expect(loadingState.get().warning).toBeNull();
    expect(trace.markWarningShown).not.toHaveBeenCalled();
  });
});

/** Starts a load on `backend` over fresh stores, the page's own timers and a loading screen, until the case ends. */
function setupLoad({ backend, telemetry = {} }: Params): LoadStand {
  const timers = createManualTimers({ start: PAGE_OPENED_AT });
  resetAllStoresForTests();
  const debugBus = createDebugBus();
  debugBus.enableBuffering();
  const chainSync = createReportSource<ChainSyncEvent>();
  const chainDetail = createReportSource<ChainDetail>();
  const netBytes = createReportSource<{ received: number }>();
  const content = createReportSource<ContentProgress>();
  // The page's loading screen, which writes the loading store, with motion off so no typing frame is asked for.
  const controller = createLoadingController({
    prefersReducedMotion: () => true,
    frames: { request: () => 0, cancel: () => undefined, now: readPageClock },
    pageContent: atom<PageContent>('page'),
    timers,
    poll: createManualPoll({ timers }),
  });
  onTestFinished(controller.dispose);
  let given: LoadingPhase[] = [];
  const loading: LoadingScreen = {
    ...controller,
    initPhases(phases) {
      given = phases;
      controller.initPhases(phases);
    },
  };
  const trace = {
    recordChainSync: vi.fn(),
    recordChainDetail: vi.fn(),
    recordBytes: vi.fn(),
    recordContent: vi.fn(),
    markWarningShown: vi.fn(),
  };
  const debug: DotliDebugEvent[] = [];
  onTestFinished(
    debugBus.watch(event => {
      if ('layer' in event) {
        debug.push(event);
      }
    }),
  );
  const progress = startLoadProgress({
    label: 'doom',
    backend,
    telemetry: {
      subscribeChainSync: chainSync.on,
      subscribeChainDetail: chainDetail.on,
      subscribeNetBytes: netBytes.on,
      ...telemetry,
    },
    blockRelay: { onProgress: content.on },
    loading,
    trace,
    chainReporter: createChainReporter({ flowId: FLOW_ID, timers, debugBus }),
    timers,
    now: readPageClock,
  });
  onTestFinished(progress.dispose);
  return { progress, timers, chainSync, chainDetail, netBytes, content, getBands: () => given, trace, debug };

  /** Reads the page's monotonic clock, which starts at zero as the page opens. */
  function readPageClock(): number {
    return timers.now() - PAGE_OPENED_AT;
  }
}

function createReportSource<Report>(): ReportSource<Report> {
  const listeners = new Set<(report: Report) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(report) {
      for (const listener of [...listeners]) {
        listener(report);
      }
    },
    isHeard: () => listeners.size > 0,
  };
}

function readProgress(): number {
  return loadingState.get().progress;
}

/** Reads the line the loading screen shows for its running stage, the name drawn with its TLD. */
function readStepLine(): string {
  return loadingState
    .get()
    .step.map(part => (typeof part === 'string' ? part : `${part.host}${part.tld}`))
    .join('');
}

function readBand(): Band {
  return { progress: readProgress(), line: readStepLine() };
}
