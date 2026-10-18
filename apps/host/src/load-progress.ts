// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what the light client and the content fetch report into the loading bar, its slow-load warnings, the network
// monitor and the debug panel's chain events. The reports come from other frames, so they are passed in.

import type { Backend, ChainRole } from '@dotli/config';
import type { ChainPeer, ChainSyncKind } from '@dotli/chains';
import type { ResolvePhase } from '@dotli/resolver';
import { emitDotliDebugEvent } from '@dotli/truapi-debug';
import { pageLoading, type LoadingPhase } from './loading-controller.js';
import { log } from '@dotli/shared';
import { productStore } from './runtime/state/product.js';
import { recordChainPhase, recordPeerCount, recordTransfer, type ChainPhase } from './state/network-monitor.js';
import {
  chainTelemetryName,
  createChainPhaseTracker,
  type CacheResult,
  type ChainSyncFacts,
} from './resolution-trace.js';
import {
  describeProgressStall,
  describeStall,
  isCriticalChain,
  STALL_WARNING_MS,
  WARNING_MIN_LOAD_MS,
  type CriticalChain,
} from './warnings.js';

// Sampled rather than emitted per step, or a long warp crowds the debug panel's ring buffer.
const CHAIN_WARP_DEBUG_MS = 1000;
// Every other 500ms byte total, which still resolves the peak.
const CHAIN_BYTES_DEBUG_MS = 1000;
/** For a load that never renders. */
const CHAIN_BYTES_DEBUG_MAX = 300;
const SPEED_WINDOW_MS = 3_000;

export interface ChainDetailFacts {
  chain: ChainRole;
  dbCache?: CacheResult | undefined;
  peers?: ChainPeer[] | undefined;
}

export interface ContentProgressFacts {
  bytesFetched: number;
  totalBytes: number | null;
}

/** Where the load's reports come from: the protocol frame and the sandbox's content fetch. Each returns its unsubscribe. */
export interface LoadEvents {
  onChainSync: (listener: (event: ChainSyncFacts) => void) => () => void;
  onChainDetail: (listener: (event: ChainDetailFacts) => void) => () => void;
  onNetBytes: (listener: (event: { received: number }) => void) => () => void;
  onContentProgress: (listener: (event: ContentProgressFacts) => void) => () => void;
}

/** The loading screen this load drives. The page's, unless a spec passes one, since the page's draws on animation frames. */
export interface LoadingScreen {
  initPhases: (phases: LoadingPhase[]) => void;
  setLoadingDomain: (domain: string) => void;
  advancePhase: (index: number) => void;
  nudgePhaseProgress: (fraction: number, stage: 'starting' | 'content') => void;
  releasePhaseProgress: () => void;
  setLoadingStage: (stage: 'preparing') => void;
  setLoadingWarning: (message: string) => void;
  /** Replaces any previous listener. */
  onProgressStall: (listener: () => void) => void;
  stopStatusTick: () => void;
}

/** The part of the resolution trace that hears the load's reports. */
export interface LoadTrace {
  chainSync: (event: ChainSyncFacts) => void;
  chainDetail: (event: ChainDetailFacts) => void;
  bytes: (received: number) => void;
  content: (fetched: number, total: number | null) => void;
  warningShown: () => void;
}

export interface LoadProgressOptions {
  label: string;
  backend: Backend;
  /** The debug panel's flow for this page load. */
  flowId: string;
  events: LoadEvents;
  trace: LoadTrace;
  loading?: LoadingScreen | undefined;
}

export interface LoadProgress {
  /** A resolver milestone. One the bar has no band for leaves it where it is. */
  resolvePhase: (phase: ResolvePhase) => void;
  /** The name is resolved, so the bar holds until the download starts. */
  nameResolved: () => void;
  /** The last band, entered just before the sandbox takes over. */
  contentFetch: () => void;
}

// Bands follow where load time goes: Asset Hub sync and the content fetch own most of the bar. Connecting takes no
// time, so it shares the Syncing band.
const PHASE_INDEX: Partial<Record<ResolvePhase, number>> = {
  'asset-hub-connecting': 1,
  'asset-hub-syncing': 1,
  'asset-hub-ready': 1,
  'resolving-content': 2,
};

/** The visitor reads the stage's copy, not the label. */
function smoldotPhases(startLabel: string, countsContentBytes: boolean): LoadingPhase[] {
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

const GATEWAY_PHASES: LoadingPhase[] = [
  { label: 'Connecting', base: 5, target: 50, expectedMs: 1200, stage: 'relay' },
  { label: 'Resolving', base: 50, target: 62, expectedMs: 1200, stage: 'resolving' },
  // No `reportsProgress`: the sandbox pulls the archive over HTTP, so nothing counts its bytes here.
  { label: 'Fetching content', base: 62, target: 95, expectedMs: 10000, stage: 'content' },
];

/** Starts the bar for one load. Call it once the label is known and before anything is resolved. */
export function startLoadProgress(options: LoadProgressOptions): LoadProgress {
  const { backend, trace, loading = pageLoading } = options;
  // Only direct mode relays bitswap through this window, so only it can report a download percentage.
  const countsContentBytes = backend === 'smoldot-direct';
  const gateway = backend === 'rpc-gateway';
  loading.initPhases(
    gateway
      ? GATEWAY_PHASES
      : smoldotPhases(backend === 'smoldot-shared-worker' ? 'Starting Worker' : 'Starting', countsContentBytes),
  );
  // Always the last band.
  const contentFetchPhase = gateway ? 2 : 3;
  loading.setLoadingDomain(options.label);
  loading.advancePhase(0);

  // On every backend: a gateway trace with no chain events is the point, not a gap.
  options.events.onChainSync(event => {
    trace.chainSync(event);
  });
  options.events.onChainDetail(event => {
    trace.chainDetail(event);
    if (event.dbCache !== undefined) {
      emitDotliDebugEvent({
        layer: 'chain',
        event: 'dbcache',
        flowId: options.flowId,
        timestamp: Date.now(),
        payload: { chain: event.chain, dbCache: event.dbCache },
      });
    }
  });
  options.events.onNetBytes(({ received }) => {
    trace.bytes(received);
  });
  options.events.onContentProgress(({ bytesFetched, totalBytes }) => {
    trace.content(bytesFetched, totalBytes);
  });

  // Typed lifecycle milestones from the protocol iframe drive the bar in direct mode. The other backends forward
  // none, so only the resolver's phases move it.
  if (backend === 'smoldot-direct') {
    followDirectChains(options, loading);
  }

  return {
    resolvePhase: phase => {
      const index = gateway ? undefined : PHASE_INDEX[phase];
      if (index !== undefined) {
        loading.advancePhase(index);
      }
    },
    nameResolved: () => {
      loading.stopStatusTick();
    },
    contentFetch: () => {
      loading.advancePhase(contentFetchPhase);
    },
  };
}

function followDirectChains(options: LoadProgressOptions, loading: LoadingScreen): void {
  const { trace, flowId } = options;
  // Per chain, since one figure would blank to zero at every handover. Every lifecycle event re-arms that chain's
  // stall timer, so a chain warns only when it sits in one state past the threshold.
  const livePeers = new Map<CriticalChain, number>();
  const stallReason = new Map<CriticalChain, string | undefined>();
  const stallTimers = new Map<CriticalChain, ReturnType<typeof setTimeout>>();
  const warned = new Set<CriticalChain>();
  let liveBytesPerSecond: number | null = null;

  // Once shown, the warning stays and only its text updates, since a blinking row reads as worse trouble. An early
  // condition is parked until the load is old enough to be slow.
  const loadStartedAt = performance.now();
  let warningShown = false;
  let pendingWarning: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const showWarning = (message: string): void => {
    const waitLeft = WARNING_MIN_LOAD_MS - (performance.now() - loadStartedAt);
    if (waitLeft > 0) {
      pendingWarning = message;
      pendingTimer ??= setTimeout(() => {
        pendingTimer = null;
        if (pendingWarning !== null) {
          warningShown = true;
          trace.warningShown();
          loading.setLoadingWarning(pendingWarning);
        }
      }, waitLeft);
      return;
    }
    warningShown = true;
    trace.warningShown();
    pendingWarning = null;
    loading.setLoadingWarning(message);
  };

  loading.onProgressStall(() => {
    if (warned.size > 0) {
      return;
    }
    showWarning(describeProgressStall(liveBytesPerSecond));
  });

  const armStallWatch = (chain: CriticalChain, state: ChainSyncKind): void => {
    const existing = stallTimers.get(chain);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    if (warned.delete(chain) && warned.size === 0) {
      // Recovered, but hiding the row would flash it, so fall back to the general slow-load line.
      if (warningShown) {
        showWarning(describeProgressStall(liveBytesPerSecond));
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
      setTimeout(() => {
        const message = describeStall({
          chain,
          peers: livePeers.get(chain) ?? null,
          bytesPerSecond: liveBytesPerSecond,
          reason: stallReason.get(chain),
        });
        if (message === null) {
          return;
        }
        warned.add(chain);
        showWarning(message);
      }, STALL_WARNING_MS),
    );
  };

  // An event only when the phase changes, since Bulletin's two taps would otherwise emit every block twice. Warp
  // progress stays in `syncing`, so it passes on a slow tick.
  const emittedPhase = new Map<ChainRole, ChainPhase>();
  const emittedWarpAt = new Map<ChainRole, number>();
  const lastWarpEmit = new Map<ChainRole, number>();
  const peersByRole = new Map<ChainRole, number>();

  const trackPhase = createChainPhaseTracker();

  options.events.onChainSync(event => {
    const role = event.chain;
    const phase = trackPhase(role, event.syncKind);
    if (event.syncKind === 'peers' && event.peers !== undefined) {
      // Independent of the phase, since the relay usually finds its peers after its last transition.
      const changed = peersByRole.get(role) !== event.peers;
      peersByRole.set(role, event.peers);
      if (changed) {
        emitDotliDebugEvent({
          layer: 'chain',
          event: 'peers',
          flowId,
          timestamp: Date.now(),
          payload: { chain: role, peers: event.peers },
        });
      }
    }
    if (phase !== undefined) {
      recordChainPhase(role, phase);
      const now = Date.now();
      const warpMoved =
        phase === 'syncing' &&
        event.at !== undefined &&
        emittedWarpAt.get(role) !== event.at &&
        now - (lastWarpEmit.get(role) ?? 0) >= CHAIN_WARP_DEBUG_MS;
      const phaseChanged = emittedPhase.get(role) !== phase;
      if (phaseChanged || warpMoved) {
        emittedPhase.set(role, phase);
        if (event.at !== undefined) {
          emittedWarpAt.set(role, event.at);
          lastWarpEmit.set(role, now);
        }
        const peers = peersByRole.get(role);
        if (phaseChanged) {
          log.event(`${chainTelemetryName(event.chain)} ${phase}`, {
            flow: 'chain',
            ...(peers === undefined ? {} : { peers }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          });
        }
        emitDotliDebugEvent({
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
    }
    // Not health samples, which arrive every second and would keep a stalled chain from ever warning.
    if (event.syncKind !== 'peers' && isCriticalChain(event.chain)) {
      if (event.syncKind === 'stalled') {
        stallReason.set(event.chain, event.reason);
      } else {
        stallReason.delete(event.chain);
      }
      armStallWatch(event.chain, event.syncKind);
    }
    switch (event.syncKind) {
      case 'peers':
        if (event.peers === undefined) {
          return;
        }
        // Every chain, including those the loading screen has no stall wording for.
        recordPeerCount(role, event.peers);
        if (isCriticalChain(event.chain)) {
          livePeers.set(event.chain, event.peers);
        }
        if (event.chain === 'bulletin' && event.peers > 0) {
          // With a peer the download can start, so the clock takes over: a cached archive never asks for a block.
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
  });

  // The whole load's throughput over a trailing window. Bitswap rides the protocol frame's WebSockets, so this one
  // counter already includes the archive.
  let chainBytes = 0;
  // Seeded with page start, so the first report already has a reading to measure against.
  const samples: { at: number; total: number }[] = [{ at: 0, total: 0 }];
  const reportSpeed = (): void => {
    const now = performance.now();
    samples.push({ at: now, total: chainBytes });
    let oldest = samples[0] ?? { at: now, total: chainBytes };
    while (samples.length > 1 && now - oldest.at > SPEED_WINDOW_MS) {
      samples.shift();
      oldest = samples[0] ?? oldest;
    }
    const span = now - oldest.at;
    if (span > 0) {
      liveBytesPerSecond = ((chainBytes - oldest.total) / span) * 1000;
      recordTransfer({ bytesPerSecond: liveBytesPerSecond });
    }
  };
  // Closes once the product is on screen, or it pushes the load's own events out of the debug panel's ring buffer.
  let lastBytesDebugAt = 0;
  let lastBytesDebugTotal = -1;
  let bytesDebugSamples = 0;
  let bytesDebugOpen = true;
  const emitBytesDebug = (received: number, at: number): void => {
    lastBytesDebugAt = at;
    lastBytesDebugTotal = received;
    bytesDebugSamples++;
    emitDotliDebugEvent({ layer: 'chain', event: 'bytes', flowId, timestamp: at, payload: { received } });
  };
  const stopBytesDebugOnLoad = productStore.subscribe(() => {
    if (productStore.get().status !== 'loaded') {
      return;
    }
    stopBytesDebugOnLoad();
    if (bytesDebugOpen && chainBytes !== lastBytesDebugTotal) {
      emitBytesDebug(chainBytes, Date.now());
    }
    bytesDebugOpen = false;
  });
  options.events.onNetBytes(({ received }) => {
    chainBytes = received;
    reportSpeed();
    const now = Date.now();
    if (
      bytesDebugOpen &&
      bytesDebugSamples < CHAIN_BYTES_DEBUG_MAX &&
      received !== lastBytesDebugTotal &&
      now - lastBytesDebugAt >= CHAIN_BYTES_DEBUG_MS
    ) {
      emitBytesDebug(received, now);
    }
  });

  // Every block the sandbox needs passes through this window, measured against the total the DAG root declares.
  options.events.onContentProgress(({ bytesFetched, totalBytes }) => {
    recordTransfer({ fetched: bytesFetched, total: totalBytes });
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
