// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what the light client and the content fetch report into the loading bar, its slow-load warnings, the network
// monitor and the debug panel's chain events. The reports come from other frames, so they are passed in.

import { hasLightClient, type Backend } from '@dotli/config';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import type { ResolvePhase } from '@dotli/resolver';
import { debugBus as pageDebugBus, type DebugBus } from '@dotli/truapi-debug';
import { pageLoading, type LoadingController, type LoadingPhase } from './createLoadingController.js';
import type { ResolutionTrace } from './startResolutionTrace.js';
import {
  createStateMachine,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { createReporter, defineCount } from '@dotli/metrics';
import { productState } from './runtime/state/productState.js';
import { networkMonitorState } from './state/networkMonitorState.js';
import { createChainReporter } from './createChainReporter.js';
import { readPageClock } from './readPageClock.js';
import { describeProgressStall, describeStall, isCriticalChain, type CriticalChain } from './warnings.js';
import { STILL_WORKING } from './stillWorking.js';

const report = createReporter({ flow: 'chain' });
const loadProgressTransitionMetric = defineCount<'error'>('load_progress.transition');

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
  timers?: Pick<Timers, 'now' | 'setTimeout'>;
  /** The monotonic clock the load's age and download rate are measured on, in milliseconds. The page's by default. */
  now?: () => number;
  /** Where the load's chain events go. The page's bus by default. */
  debugBus?: DebugBus;
};

/**
 * The slow-load warning. Once shown, it stays and only its text updates, since a blinking row reads as worse trouble.
 * An early condition is parked until the load is old enough to be slow. A parked warning's timer shows it only while
 * that warning is still parked.
 */
type Warning = { kind: 'hidden' } | { kind: 'pending'; message: string; timer: unknown } | { kind: 'shown' };

/** What a critical chain's stall message reads, kept across its watches. */
type StallFacts = { peers: number | null; reason: string | undefined };

/**
 * One critical chain's stall watch. Every lifecycle event re-arms it, so a chain warns only when it sits in one state
 * past the threshold. A watch's timer warns only while that watch is still the chain's.
 */
type StallWatch =
  | ({ kind: 'quiet' } & StallFacts)
  | ({ kind: 'watching'; timer: unknown } & StallFacts)
  | ({ kind: 'warned' } & StallFacts);

/**
 * The sampled report of the load's byte totals to the debug panel. It closes once the product is on screen, or it
 * pushes the load's own events out of the panel's ring buffer.
 */
type ByteTotals =
  { kind: 'open'; latest: number; lastAt: number; lastTotal: number; samples: number } | { kind: 'closed' };

/** The whole load's throughput over a trailing window. */
type Throughput = { samples: readonly { at: number; total: number }[]; bytesPerSecond: number | null };

/**
 * A gateway has no chains to follow and leaves the resolver's milestones alone, so only the download moves its bar
 * past the first band. A light client's chains move it, and warn when they stall.
 */
type ProgressState =
  | { kind: 'idle' }
  | { kind: 'gateway'; stops: readonly (() => void)[] }
  | {
      kind: 'lightClient';
      stops: readonly (() => void)[];
      warning: Warning;
      // Per chain, since one figure would blank to zero at every handover.
      watches: ReadonlyMap<CriticalChain, StallWatch>;
      byteTotals: ByteTotals;
      throughput: Throughput;
    }
  | { kind: 'disposed' };

type LightClientState = Extract<ProgressState, { kind: 'lightClient' }>;

type ProgressEvent =
  | { kind: 'started' }
  | { kind: 'chainSynced'; sync: ChainSyncEvent }
  | { kind: 'chainDetailed'; detail: ChainDetail }
  | { kind: 'netBytes'; received: number }
  | ({ kind: 'contentProgressed' } & ContentProgressFacts)
  | { kind: 'barStalled' }
  | { kind: 'productLoaded' }
  | { kind: 'phaseResolved'; phase: ResolvePhase }
  | { kind: 'nameResolved' }
  | { kind: 'contentFetchEntered' }
  | { kind: 'stallDue'; chain: CriticalChain; timer: unknown }
  | { kind: 'warningDue'; timer: unknown }
  | { kind: 'disposed' };

type ProgressMachine = MachineTypes<ProgressState, ProgressEvent>;

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
 * resolved. Never throws: a throw of the loading screen or of a subscription in `events` is reported, and the load
 * then moves no bar.
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
  const phases = getLoadingPhases(backend);
  const loadStartedAt = readClock();
  const chainReporter = createChainReporter({ flowId, timers, debugBus });
  const recordDetail: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'chainDetailed'> = (_state, { detail }) => {
    trace.recordChainDetail(detail);
    chainReporter.recordDetail(detail);
  };
  const holdBar: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'nameResolved'> = () => {
    loading.stopStatusTick();
  };
  const enterContentBand: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'contentFetchEntered'> = () => {
    // The download is always the last band.
    loading.advancePhase(phases.length - 1);
  };
  const stop: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'disposed'> = (
    { stops },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed' });
    for (const stopListening of stops) {
      stopListening();
    }
  };
  const progress = createStateMachine<ProgressMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, { emitState, update }) {
          loading.initPhases(phases);
          loading.setLoadingDomain(label);
          loading.advancePhase(0);
          // On every backend: a gateway trace with no chain events is the point, not a gap.
          const subscribes = [
            () =>
              events.onChainSync(sync => {
                update({ kind: 'chainSynced', sync });
              }),
            () =>
              events.onChainDetail(detail => {
                update({ kind: 'chainDetailed', detail });
              }),
            () =>
              events.onNetBytes(({ received }) => {
                update({ kind: 'netBytes', received });
              }),
            () =>
              events.onContentProgress(facts => {
                update({ kind: 'contentProgressed', ...facts });
              }),
          ];
          if (!gateway) {
            subscribes.push(
              () =>
                loading.onProgressStall(() => {
                  update({ kind: 'barStalled' });
                }),
              () =>
                productState.store.listen(product => {
                  if (product.status === 'loaded') {
                    update({ kind: 'productLoaded' });
                  }
                }),
            );
          }
          const stops: (() => void)[] = [];
          // A subscription that throws leaves none of the others behind, as the progress then stays idle.
          try {
            for (const subscribe of subscribes) {
              stops.push(subscribe());
            }
          } catch (error) {
            for (const stopListening of stops) {
              try {
                stopListening();
              } catch (stopError) {
                report.defect(stopError, {
                  step: 'transition',
                  metric: loadProgressTransitionMetric,
                  message: '[dot.li] A load progress unsubscribe threw while the start failed',
                });
              }
            }
            throw error;
          }
          if (gateway) {
            emitState({ kind: 'gateway', stops });
            return;
          }
          emitState({
            kind: 'lightClient',
            stops,
            warning: { kind: 'hidden' },
            watches: new Map(),
            byteTotals: { kind: 'open', latest: 0, lastAt: 0, lastTotal: -1, samples: 0 },
            // Seeded with page start, so the first report already has a reading to measure against.
            throughput: { samples: [{ at: 0, total: 0 }], bytesPerSecond: null },
          });
        },
      },
      gateway: {
        chainSynced(_state, { sync }) {
          trace.recordChainSync(sync);
        },
        chainDetailed: recordDetail,
        netBytes(_state, { received }) {
          trace.recordBytes(received);
        },
        contentProgressed(_state, { bytesFetched, totalBytes }) {
          trace.recordContent(bytesFetched, totalBytes);
        },
        nameResolved: holdBar,
        contentFetchEntered: enterContentBand,
        disposed: stop,
      },
      lightClient: {
        chainSynced(state, { sync }, transition) {
          trace.recordChainSync(sync);
          watchChain(state, sync, transition);
          chainReporter.record(sync);
          moveBarOnChainSync(sync, loading);
        },
        chainDetailed: recordDetail,
        netBytes(state, { received }, { emitState }) {
          const throughput = measureThroughput(state.throughput, received, readClock());
          const totals = state.byteTotals;
          const now = timers.now();
          // A new total is sampled a second after the last, up to the cap.
          const sampled =
            totals.kind === 'open' &&
            totals.samples < CHAIN_BYTES_DEBUG_MAX &&
            received !== totals.lastTotal &&
            now - totals.lastAt >= CHAIN_BYTES_DEBUG_MS;
          let byteTotals = totals;
          if (totals.kind === 'open') {
            byteTotals = sampled
              ? { kind: 'open', latest: received, lastAt: now, lastTotal: received, samples: totals.samples + 1 }
              : { ...totals, latest: received };
          }
          emitState({ ...state, throughput, byteTotals });
          trace.recordBytes(received);
          if (throughput.bytesPerSecond !== null) {
            networkMonitorState.recordTransfer({ bytesPerSecond: throughput.bytesPerSecond });
          }
          if (sampled) {
            emitByteTotal(received, now);
          }
        },
        contentProgressed(_state, { bytesFetched, totalBytes }) {
          // Records before it moves the bar, so the record sees the bar unmoved.
          trace.recordContent(bytesFetched, totalBytes);
          // Every block the sandbox needs passes through this window, measured against the total the DAG root declares.
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
        },
        barStalled(state, _event, transition) {
          // A chain whose stall warned names the cause, so a parked bar does not replace its line.
          const message = describeProgressStall(state.throughput.bytesPerSecond);
          if (message === null || hasWarnedWatch(state.watches)) {
            return;
          }
          showWarning(state, message, transition);
        },
        productLoaded(state, _event, { emitState }) {
          const totals = state.byteTotals;
          if (totals.kind === 'closed') {
            return;
          }
          emitState({ ...state, byteTotals: { kind: 'closed' } });
          if (totals.latest !== totals.lastTotal) {
            emitByteTotal(totals.latest, timers.now());
          }
        },
        phaseResolved(_state, { phase }) {
          const index = PHASE_INDEX[phase];
          if (index !== undefined) {
            loading.advancePhase(index);
          }
        },
        nameResolved: holdBar,
        contentFetchEntered: enterContentBand,
        stallDue(state, { chain, timer }, transition) {
          const watch = state.watches.get(chain);
          // A timer of a watch since re-armed or quieted warns of nothing.
          if (watch?.kind !== 'watching' || watch.timer !== timer) {
            return;
          }
          const facts: StallFacts = { peers: watch.peers, reason: watch.reason };
          const message = describeStall({ chain, bytesPerSecond: state.throughput.bytesPerSecond, ...facts });
          if (message === null) {
            transition.emitState(withWatch(state, chain, { kind: 'quiet', ...facts }));
            return;
          }
          const warned = withWatch(state, chain, { kind: 'warned', ...facts });
          transition.emitState(warned);
          showWarning(warned, message, transition);
        },
        warningDue(state, { timer }, transition) {
          // A timer of a warning since shown or dropped shows nothing.
          if (state.warning.kind !== 'pending' || state.warning.timer !== timer) {
            return;
          }
          revealWarning(state, state.warning.message, transition);
        },
        disposed: stop,
      },
      disposed: null,
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: loadProgressTransitionMetric,
        message: '[dot.li] A load progress transition threw',
      });
    },
  });
  progress.update({ kind: 'started' });

  return {
    /**
     * Moves the bar to a resolver milestone's band. One the bar has no band for leaves it where it is. Ignored once
     * disposed. Never throws.
     */
    resolvePhase,
    /** Holds the bar until the download starts, as the name is resolved. Ignored once disposed. Never throws. */
    markNameResolved,
    /** Enters the last band, just before the sandbox takes over. Ignored once disposed. Never throws. */
    enterContentFetch,
    /**
     * Stops hearing the load's reports, the product store and the loading screen's stalls, so no warning shows after.
     * Repeating it does nothing. Never throws: a throw of an unsubscribe in `events` is reported.
     */
    dispose,
  };

  function resolvePhase(phase: ResolvePhase): void {
    progress.update({ kind: 'phaseResolved', phase });
  }

  function markNameResolved(): void {
    progress.update({ kind: 'nameResolved' });
  }

  function enterContentFetch(): void {
    progress.update({ kind: 'contentFetchEntered' });
  }

  function dispose(): void {
    progress.update({ kind: 'disposed' });
  }

  /**
   * Re-arms a critical chain's stall watch on its lifecycle milestone, or keeps a peer sample for the wording. A chain
   * that recovers from the last warning falls back to the general slow-load line.
   */
  function watchChain(state: LightClientState, sync: ChainSyncEvent, transition: Transition<ProgressMachine>): void {
    const { chain } = sync;
    if (!isCriticalChain(chain)) {
      return;
    }
    const watch: StallWatch = state.watches.get(chain) ?? { kind: 'quiet', peers: null, reason: undefined };
    // A health sample arrives every second, so it never re-arms the watch, or a stalled chain would never warn.
    if (sync.kind === 'peers') {
      if (sync.peers !== undefined) {
        transition.emitState(withWatch(state, chain, { ...watch, peers: sync.peers }));
      }
      return;
    }
    const facts: StallFacts = { peers: watch.peers, reason: sync.kind === 'stalled' ? sync.reason : undefined };
    let next: StallWatch = { kind: 'quiet', ...facts };
    if (sync.kind !== 'bootstrapComplete') {
      const timer = timers.setTimeout(() => {
        transition.update({ kind: 'stallDue', chain, timer });
      }, STALL_WARNING_MS);
      next = { kind: 'watching', timer, ...facts };
    }
    const watched = withWatch(state, chain, next);
    transition.emitState(watched);
    if (watch.kind !== 'warned' || hasWarnedWatch(watched.watches)) {
      return;
    }
    // Recovered, but hiding the row would flash it, so fall back to the general slow-load line.
    switch (state.warning.kind) {
      case 'hidden':
        return;
      case 'pending':
        transition.emitState({ ...watched, warning: { kind: 'hidden' } });
        return;
      case 'shown':
        // A shown warning is past the minimum load age already.
        revealWarning(watched, describeProgressStall(state.throughput.bytesPerSecond) ?? STILL_WORKING, transition);
        return;
    }
  }

  /** Shows `message` as the slow-load warning, or parks it until the load is old enough to be slow. */
  function showWarning(state: LightClientState, message: string, transition: Transition<ProgressMachine>): void {
    const waitLeft = WARNING_MIN_LOAD_MS - (readClock() - loadStartedAt);
    if (waitLeft <= 0) {
      revealWarning(state, message, transition);
      return;
    }
    // A later message replaces the parked one, and the parked one's timer shows it.
    if (state.warning.kind === 'pending') {
      transition.emitState({ ...state, warning: { ...state.warning, message } });
      return;
    }
    const timer = timers.setTimeout(() => {
      transition.update({ kind: 'warningDue', timer });
    }, waitLeft);
    transition.emitState({ ...state, warning: { kind: 'pending', message, timer } });
  }

  /** Shows `message` as the slow-load warning at once, in place of a parked one. */
  function revealWarning(state: LightClientState, message: string, { emitState }: Transition<ProgressMachine>): void {
    emitState({ ...state, warning: { kind: 'shown' } });
    trace.markWarningShown();
    loading.setLoadingWarning(message);
  }

  function emitByteTotal(received: number, at: number): void {
    debugBus.emit({ layer: 'chain', event: 'bytes', flowId, timestamp: at, payload: { received } });
  }
}

/** `state` with `chain`'s stall watch replaced by `watch`. */
function withWatch(state: LightClientState, chain: CriticalChain, watch: StallWatch): LightClientState {
  return { ...state, watches: new Map(state.watches).set(chain, watch) };
}

/** Returns whether a critical chain's stall gave the warning. Never throws. */
function hasWarnedWatch(watches: LightClientState['watches']): boolean {
  return [...watches.values()].some(watch => watch.kind === 'warned');
}

/**
 * Takes `received`, the load's byte total so far, at `now` into the trailing window. Bitswap rides the protocol frame's
 * WebSockets, so the one byte counter it reads already includes the archive. The rate stays as it was while the window
 * spans no time.
 */
function measureThroughput({ samples, bytesPerSecond }: Throughput, received: number, now: number): Throughput {
  const kept = [...samples, { at: now, total: received }];
  while (kept.length > 1 && now - (kept[0]?.at ?? now) > SPEED_WINDOW_MS) {
    kept.shift();
  }
  const oldest = kept[0] ?? { at: now, total: received };
  const span = now - oldest.at;
  return { samples: kept, bytesPerSecond: span > 0 ? ((received - oldest.total) / span) * 1000 : bytesPerSecond };
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
