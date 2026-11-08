// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what the light client and the content fetch report into the loading bar, its slow-load warnings, the network
// monitor and the debug panel's chain events. The reports come from other frames, so they are passed in.

import { hasLightClient, type Backend, type ChainRole } from '@dotli/config';
import type { ChainDetail, ChainSyncEvent, ChainSyncKind } from '@dotli/chains';
import type { ResolvePhase } from '@dotli/resolver';
import { debugBus as pageDebugBus, type DebugBus } from '@dotli/truapi-debug';
import { pageLoading, type LoadingController, type LoadingPhase } from './createLoadingController.js';
import type { ResolutionTrace } from './startResolutionTrace.js';
import { log, realTimers, type Timers } from '@dotli/shared';
import { productState } from './runtime/state/productState.js';
import { networkMonitorState, type ChainPhase } from './state/networkMonitorState.js';
import { createChainPhaseTracker } from './createChainPhaseTracker.js';
import { getChainTelemetryName } from './getChainTelemetryName.js';
import { readPageClock } from './readPageClock.js';
import { describeProgressStall, describeStall, isCriticalChain, type CriticalChain } from './warnings.js';
import { STILL_WORKING } from './stillWorking.js';

export type ContentProgressFacts = {
  bytesFetched: number;
  totalBytes: number | null;
};

/** Where the load's reports come from: the protocol frame and the sandbox's content fetch. Each returns its unsubscribe. */
export type LoadEvents = {
  /** Calls `listener` with each chain's lifecycle milestones. Returns its unsubscribe. Never throws. */
  onChainSync: (listener: (event: ChainSyncEvent) => void) => () => void;
  /** Calls `listener` with each chain's details. Returns its unsubscribe. Never throws. */
  onChainDetail: (listener: (event: ChainDetail) => void) => () => void;
  /** Calls `listener` with the load's byte total so far. Returns its unsubscribe. Never throws. */
  onNetBytes: (listener: (event: { received: number }) => void) => () => void;
  /** Calls `listener` with the content fetch's progress. Returns its unsubscribe. Never throws. */
  onContentProgress: (listener: (event: ContentProgressFacts) => void) => () => void;
};

/** The loading screen this load drives. The page's, unless a spec passes one, since the page's draws on animation frames. */
export type LoadingScreen = Pick<
  LoadingController,
  | 'initPhases'
  | 'setLoadingDomain'
  | 'advancePhase'
  | 'nudgePhaseProgress'
  | 'releasePhaseProgress'
  | 'setLoadingStage'
  | 'setLoadingWarning'
  | 'onProgressStall'
  | 'stopStatusTick'
>;

/** The part of the resolution trace that hears the load's reports. */
export type LoadTrace = Pick<
  ResolutionTrace,
  'recordChainSync' | 'recordChainDetail' | 'recordBytes' | 'recordContent' | 'markWarningShown'
>;

export type LoadProgress = ReturnType<typeof startLoadProgress>;

type Params = {
  label: string;
  backend: Backend;
  /** The debug panel's flow for this page load. */
  flowId: string;
  events: LoadEvents;
  trace: LoadTrace;
  loading?: LoadingScreen | undefined;
  /** The clock the debug events are stamped with, and the timers the warnings wait on. The page's own by default. */
  timers?: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>;
  /** The monotonic clock the load's age and download rate are measured on, in milliseconds. The page's by default. */
  now?: () => number;
  /** Where the load's chain events go. The page's bus by default. */
  debugBus?: DebugBus;
};

type FollowLightClientChainsParams = {
  events: LoadEvents;
  trace: LoadTrace;
  flowId: string;
  loading: LoadingScreen;
  timers: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>;
  /** The monotonic clock, in milliseconds. */
  readClock: () => number;
  debugBus: DebugBus;
};

type CreateStallWarningsParams = Pick<FollowLightClientChainsParams, 'trace' | 'loading' | 'timers' | 'readClock'> & {
  /** Returns the load's latest download rate in bytes per second, or null before the first. Never throws. */
  readBytesPerSecond: () => number | null;
};

type CreateChainReporterParams = Pick<FollowLightClientChainsParams, 'flowId' | 'timers' | 'debugBus'>;

type CreateThroughputMeterParams = Pick<FollowLightClientChainsParams, 'readClock'>;

type CreateByteTotalsReporterParams = Pick<FollowLightClientChainsParams, 'flowId' | 'timers' | 'debugBus'>;

type FollowContentProgressParams = Pick<FollowLightClientChainsParams, 'events' | 'loading'>;

// Sampled rather than emitted per step, or a long warp crowds the debug panel's ring buffer.
const CHAIN_WARP_DEBUG_MS = 1000;
// Every other 500ms byte total, which still resolves the peak.
const CHAIN_BYTES_DEBUG_MS = 1000;
/** For a load that never renders. */
const CHAIN_BYTES_DEBUG_MAX = 300;
const SPEED_WINDOW_MS = 3_000;

/** How long a chain may sit in one lifecycle state before it owes an explanation. */
const STALL_WARNING_MS = 3_000;

/**
 * Early warnings read as failure on loads that would succeed. A condition that fires earlier is shown at this mark if
 * it still stands.
 */
const WARNING_MIN_LOAD_MS = 5_000;

// Bands follow where load time goes: Asset Hub sync and the content fetch own most of the bar. Connecting takes no
// time, so it shares the Syncing band.
const PHASE_INDEX: Partial<Record<ResolvePhase, number>> = {
  'asset-hub-connecting': 1,
  'asset-hub-syncing': 1,
  'asset-hub-ready': 1,
  'resolving-content': 2,
};

const GATEWAY_PHASES: LoadingPhase[] = [
  { label: 'Connecting', base: 5, target: 50, expectedMs: 1200, stage: 'relay' },
  { label: 'Resolving', base: 50, target: 62, expectedMs: 1200, stage: 'resolving' },
  // No `reportsProgress`: the sandbox pulls the archive over HTTP, so nothing counts its bytes here.
  { label: 'Fetching content', base: 62, target: 95, expectedMs: 10000, stage: 'content' },
];

/**
 * Starts the bar for one load and returns what moves it. Call it once the label is known and before anything is
 * resolved. Throws only as a subscription in `events` does.
 */
export function startLoadProgress({
  label,
  backend,
  flowId,
  events,
  trace,
  loading = pageLoading,
  timers = realTimers,
  now: readClock = readPageClock,
  debugBus = pageDebugBus,
}: Params) {
  const gateway = !hasLightClient(backend);
  loading.initPhases(getLoadingPhases(backend));
  // Always the last band.
  const contentFetchPhase = gateway ? 2 : 3;
  loading.setLoadingDomain(label);
  loading.advancePhase(0);

  // On every backend: a gateway trace with no chain events is the point, not a gap.
  const releases = [
    events.onChainSync(event => {
      trace.recordChainSync(event);
    }),
    events.onChainDetail(event => {
      trace.recordChainDetail(event);
      if (event.dbCache !== undefined) {
        debugBus.emit({
          layer: 'chain',
          event: 'dbcache',
          flowId,
          timestamp: timers.now(),
          payload: { chain: event.chain, dbCache: event.dbCache },
        });
      }
    }),
    events.onNetBytes(({ received }) => {
      trace.recordBytes(received);
    }),
    events.onContentProgress(({ bytesFetched, totalBytes }) => {
      trace.recordContent(bytesFetched, totalBytes);
    }),
  ];

  // The light client's lifecycle milestones drive the bar, wherever it runs. A gateway has no chains to follow, so
  // only the resolver's phases move it.
  if (!gateway) {
    releases.push(followLightClientChains({ events, trace, flowId, loading, timers, readClock, debugBus }));
  }

  function resolvePhase(phase: ResolvePhase): void {
    const index = gateway ? undefined : PHASE_INDEX[phase];
    if (index !== undefined) {
      loading.advancePhase(index);
    }
  }

  function markNameResolved(): void {
    loading.stopStatusTick();
  }

  function enterContentFetch(): void {
    loading.advancePhase(contentFetchPhase);
  }

  function dispose(): void {
    for (const release of releases.splice(0)) {
      release();
    }
  }

  return {
    /** Moves the bar to a resolver milestone's band. One the bar has no band for leaves it where it is. Never throws. */
    resolvePhase,
    /** Holds the bar until the download starts, as the name is resolved. Never throws. */
    markNameResolved,
    /** Enters the last band, just before the sandbox takes over. Never throws. */
    enterContentFetch,
    /**
     * Stops hearing the load's reports, the product store and the loading screen's stalls, and clears the warnings'
     * timers. Repeating it does nothing. Throws only as an unsubscribe in `events` does.
     */
    dispose,
  };
}

function getLoadingPhases(backend: Backend): LoadingPhase[] {
  switch (backend) {
    case 'rpc-gateway':
      return GATEWAY_PHASES;
    case 'smoldot-shared-worker':
      return getSmoldotPhases('Starting Worker', false);
    case 'smoldot-direct':
      // Only direct mode relays bitswap through this window, so only it can report a download percentage.
      return getSmoldotPhases('Starting', true);
  }
}

/** The visitor reads the stage's copy, not the label. */
function getSmoldotPhases(startLabel: string, countsContentBytes: boolean): LoadingPhase[] {
  return [
    { label: startLabel, base: 2, target: 10, expectedMs: 770, stage: 'starting' },
    { label: 'Syncing Asset Hub', base: 10, target: 55, expectedMs: 6500, stage: 'assetHub' },
    { label: 'Resolving', base: 55, target: 62, expectedMs: 1200, stage: 'resolving' },
    {
      label: 'Fetching content',
      base: 62,
      target: 95,
      expectedMs: 10000,
      stage: 'content',
      // Driven by counted bytes, only where something counts them, or the bar would hold at 62 for the whole fetch.
      reportsProgress: countsContentBytes,
    },
  ];
}

/** Returns the function that stops following, which clears the warnings' timers. Throws only as `events` does. */
function followLightClientChains({
  events,
  trace,
  flowId,
  loading,
  timers,
  readClock,
  debugBus,
}: FollowLightClientChainsParams): () => void {
  const throughput = createThroughputMeter({ readClock });
  const warnings = createStallWarnings({
    trace,
    loading,
    timers,
    readClock,
    readBytesPerSecond: throughput.readBytesPerSecond,
  });
  const chains = createChainReporter({ flowId, timers, debugBus });
  const stopChainSync = events.onChainSync(event => {
    chains.record(event);
    warnings.record(event);
    moveBarOnChainSync(event, loading);
  });
  const byteTotals = createByteTotalsReporter({ flowId, timers, debugBus });
  const stopNetBytes = events.onNetBytes(({ received }) => {
    throughput.record(received);
    byteTotals.record(received);
  });
  const stopContentProgress = followContentProgress({ events, loading });

  return stopFollowing;

  function stopFollowing(): void {
    stopChainSync();
    byteTotals.dispose();
    stopNetBytes();
    stopContentProgress();
    warnings.dispose();
  }
}

/**
 * Builds the slow-load warnings: a critical chain that sits in one state too long, or a bar that stops moving with no
 * chain to blame. Once shown, the warning stays and only its text updates, since a blinking row reads as worse trouble.
 * An early condition is parked until the load is old enough to be slow.
 */
function createStallWarnings({ trace, loading, timers, readClock, readBytesPerSecond }: CreateStallWarningsParams) {
  // Per chain, since one figure would blank to zero at every handover. Every lifecycle event re-arms that chain's
  // stall timer, so a chain warns only when it sits in one state past the threshold.
  const livePeers = new Map<CriticalChain, number>();
  const stallReason = new Map<CriticalChain, string | undefined>();
  const stallTimers = new Map<CriticalChain, unknown>();
  const warned = new Set<CriticalChain>();

  const loadStartedAt = readClock();
  let warningShown = false;
  let pendingWarning: string | null = null;
  let pendingTimer: unknown = null;

  function showWarning(message: string): void {
    const waitLeft = WARNING_MIN_LOAD_MS - (readClock() - loadStartedAt);
    if (waitLeft > 0) {
      pendingWarning = message;
      pendingTimer ??= timers.setTimeout(() => {
        pendingTimer = null;
        if (pendingWarning !== null) {
          warningShown = true;
          trace.markWarningShown();
          loading.setLoadingWarning(pendingWarning);
        }
      }, waitLeft);
      return;
    }
    warningShown = true;
    trace.markWarningShown();
    pendingWarning = null;
    loading.setLoadingWarning(message);
  }

  const stopHearingStalls = loading.onProgressStall(() => {
    const message = describeProgressStall(readBytesPerSecond());
    if (warned.size > 0 || message === null) {
      return;
    }
    showWarning(message);
  });

  function armStallWatch(chain: CriticalChain, state: ChainSyncKind): void {
    const existing = stallTimers.get(chain);
    if (existing !== undefined) {
      timers.clearTimeout(existing);
    }
    if (warned.delete(chain) && warned.size === 0) {
      // Recovered, but hiding the row would flash it, so fall back to the general slow-load line.
      if (warningShown) {
        showWarning(describeProgressStall(readBytesPerSecond()) ?? STILL_WORKING);
      } else {
        pendingWarning = null;
      }
    }
    if (state === 'bootstrapComplete') {
      stallTimers.delete(chain);
      return;
    }
    stallTimers.set(
      chain,
      timers.setTimeout(() => {
        const message = describeStall({
          chain,
          peers: livePeers.get(chain) ?? null,
          bytesPerSecond: readBytesPerSecond(),
          reason: stallReason.get(chain),
        });
        if (message === null) {
          return;
        }
        warned.add(chain);
        showWarning(message);
      }, STALL_WARNING_MS),
    );
  }

  return {
    /**
     * Re-arms a critical chain's stall watch on its lifecycle events, and keeps its peer count for the wording. Throws
     * only as `timers` does.
     */
    record(event: ChainSyncEvent): void {
      const chain = event.chain;
      if (!isCriticalChain(chain)) {
        return;
      }
      // A health sample arrives every second, so it never re-arms the watch, or a stalled chain would never warn.
      if (event.kind === 'peers') {
        if (event.peers !== undefined) {
          livePeers.set(chain, event.peers);
        }
        return;
      }
      if (event.kind === 'stalled') {
        stallReason.set(chain, event.reason);
      } else {
        stallReason.delete(chain);
      }
      armStallWatch(chain, event.kind);
    },
    /** Stops hearing the bar's stalls and clears the warnings' timers. Throws only as `timers` does. */
    dispose(): void {
      stopHearingStalls();
      for (const timer of stallTimers.values()) {
        timers.clearTimeout(timer);
      }
      stallTimers.clear();
      if (pendingTimer !== null) {
        timers.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}

/**
 * Builds the report of each chain's phase and peers to the network monitor and the debug panel. A debug event only
 * when the phase changes, since Bulletin's two taps would otherwise emit every block twice. Warp progress stays in
 * `syncing`, so it passes on a slow tick.
 */
function createChainReporter({ flowId, timers, debugBus }: CreateChainReporterParams) {
  const emittedPhase = new Map<ChainRole, ChainPhase>();
  const emittedWarpAt = new Map<ChainRole, number>();
  const lastWarpEmit = new Map<ChainRole, number>();
  const peersByRole = new Map<ChainRole, number>();

  const trackPhase = createChainPhaseTracker();

  function recordPeers(role: ChainRole, peers: number): void {
    // Independent of the phase, since the relay usually finds its peers after its last transition.
    const changed = peersByRole.get(role) !== peers;
    peersByRole.set(role, peers);
    if (changed) {
      debugBus.emit({
        layer: 'chain',
        event: 'peers',
        flowId,
        timestamp: timers.now(),
        payload: { chain: role, peers },
      });
    }
    // Every chain, including those the loading screen has no stall wording for.
    networkMonitorState.recordPeerCount(role, peers);
  }

  function recordPhase(event: ChainSyncEvent, phase: ChainPhase): void {
    const role = event.chain;
    networkMonitorState.recordChainPhase(role, phase);
    const now = timers.now();
    const warpMoved =
      phase === 'syncing' &&
      event.at !== undefined &&
      emittedWarpAt.get(role) !== event.at &&
      now - (lastWarpEmit.get(role) ?? 0) >= CHAIN_WARP_DEBUG_MS;
    const phaseChanged = emittedPhase.get(role) !== phase;
    if (!phaseChanged && !warpMoved) {
      return;
    }
    emittedPhase.set(role, phase);
    if (event.at !== undefined) {
      emittedWarpAt.set(role, event.at);
      lastWarpEmit.set(role, now);
    }
    const peers = peersByRole.get(role);
    if (phaseChanged) {
      log.event(`${getChainTelemetryName(event.chain)} ${phase}`, {
        flow: 'chain',
        ...(peers === undefined ? {} : { peers }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
    }
    debugBus.emit({
      layer: 'chain',
      event: 'phase',
      flowId,
      timestamp: now,
      payload: {
        chain: role,
        phase,
        ...(peers === undefined ? {} : { peers }),
        ...(event.at === undefined ? {} : { warpAt: event.at }),
        ...(event.target === undefined ? {} : { warpTarget: event.target }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
    });
  }

  return {
    /** Reports the phase `event` leaves its chain in, and its peer count. Never throws. */
    record(event: ChainSyncEvent): void {
      const phase = trackPhase(event.chain, event.kind);
      if (event.kind === 'peers' && event.peers !== undefined) {
        recordPeers(event.chain, event.peers);
      }
      if (phase !== undefined) {
        recordPhase(event, phase);
      }
    },
  };
}

/** Moves the loading bar on a chain's lifecycle milestone. Never throws. */
function moveBarOnChainSync(event: ChainSyncEvent, loading: LoadingScreen): void {
  switch (event.kind) {
    case 'peers':
      // With a peer the download can start, so the clock takes over: a cached archive never asks for a block.
      if (event.chain === 'bulletin' && event.peers !== undefined && event.peers > 0) {
        loading.releasePhaseProgress();
      }
      return;
    case 'warpSyncProgress': {
      // The one true percentage smoldot offers. Adding the relay happens inside the starting band, so its warp
      // fills that band.
      const { at, target } = event;
      if (event.chain === 'relay' && at !== undefined && target !== undefined && target > 0 && at <= target) {
        loading.nudgePhaseProgress(at / target, 'starting');
      }
      return;
    }
    case 'firstPeer':
      if (event.chain === 'assethub') {
        loading.advancePhase(1);
      }
      return;
    case 'bootstrapComplete':
      if (event.chain === 'assethub') {
        loading.advancePhase(2);
      }
      return;
    case 'warpSyncFinished':
      // The last sample lands short of the target, which would leave the band just below full.
      if (event.chain === 'relay') {
        loading.nudgePhaseProgress(1, 'starting');
      }
      return;
    case 'connecting':
    case 'stalled':
    case 'recovered':
      // The per-chain peer counts already show these.
      return;
  }
}

/**
 * Builds the meter of the whole load's throughput over a trailing window. Bitswap rides the protocol frame's
 * WebSockets, so the one byte counter it reads already includes the archive.
 */
function createThroughputMeter({ readClock }: CreateThroughputMeterParams) {
  let bytesPerSecond: number | null = null;
  // Seeded with page start, so the first report already has a reading to measure against.
  const samples: { at: number; total: number }[] = [{ at: 0, total: 0 }];
  return {
    /**
     * Takes `received`, the load's byte total so far, and reports the rate to the network monitor. Throws only as
     * `readClock` does.
     */
    record(received: number): void {
      const now = readClock();
      samples.push({ at: now, total: received });
      let oldest = samples[0] ?? { at: now, total: received };
      while (samples.length > 1 && now - oldest.at > SPEED_WINDOW_MS) {
        samples.shift();
        oldest = samples[0] ?? oldest;
      }
      const span = now - oldest.at;
      if (span > 0) {
        bytesPerSecond = ((received - oldest.total) / span) * 1000;
        networkMonitorState.recordTransfer({ bytesPerSecond });
      }
    },
    /** Returns the latest rate in bytes per second, or null before the first. Never throws. */
    readBytesPerSecond: (): number | null => bytesPerSecond,
  };
}

/**
 * Builds the sampled report of the load's byte totals to the debug panel. It closes once the product is on screen, or
 * it pushes the load's own events out of the panel's ring buffer.
 */
function createByteTotalsReporter({ flowId, timers, debugBus }: CreateByteTotalsReporterParams) {
  let latest = 0;
  let lastAt = 0;
  let lastTotal = -1;
  let samples = 0;
  let open = true;
  function emitTotal(received: number, at: number): void {
    lastAt = at;
    lastTotal = received;
    samples++;
    debugBus.emit({ layer: 'chain', event: 'bytes', flowId, timestamp: at, payload: { received } });
  }
  const stopOnLoad = productState.store.listen(() => {
    if (productState.store.get().status !== 'loaded') {
      return;
    }
    stopOnLoad();
    if (open && latest !== lastTotal) {
      emitTotal(latest, timers.now());
    }
    open = false;
  });
  return {
    /** Takes `received`, the load's byte total so far, and reports it when a sample is due. Never throws. */
    record(received: number): void {
      latest = received;
      const now = timers.now();
      if (open && samples < CHAIN_BYTES_DEBUG_MAX && received !== lastTotal && now - lastAt >= CHAIN_BYTES_DEBUG_MS) {
        emitTotal(received, now);
      }
    },
    /** Stops waiting for the product to be on screen. Never throws. */
    dispose(): void {
      stopOnLoad();
    },
  };
}

/**
 * Moves the bar's last band with the content fetch. Every block the sandbox needs passes through this window, measured
 * against the total the DAG root declares. Returns the function that stops following. Throws only as `events` does.
 */
function followContentProgress({ events, loading }: FollowContentProgressParams): () => void {
  return events.onContentProgress(({ bytesFetched, totalBytes }) => {
    networkMonitorState.recordTransfer({ fetched: bytesFetched, total: totalBytes });
    if (totalBytes === null) {
      // No declared total, so no percentage: the clock takes the bar back.
      loading.releasePhaseProgress();
    }
    if (totalBytes !== null && totalBytes > 0) {
      loading.nudgePhaseProgress(bytesFetched / totalBytes, 'content');
      // The tail is the sandbox unpacking and painting. Only relayed blocks count, so this cannot fire early.
      if (bytesFetched >= totalBytes) {
        loading.setLoadingStage('preparing');
      }
    }
  });
}
