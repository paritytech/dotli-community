// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what the light client and the content fetch report into the loading bar, its slow-load warnings, the network
// monitor and the debug panel's chain events. The reports come from other frames, so they are passed in.

import { hasLightClient, type Backend, type ChainRole } from '@dotli/config';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import type { ResolvePhase } from '@dotli/resolver';
import { debugBus as pageDebugBus, type DebugBus } from '@dotli/truapi-debug';
import { pageLoading, type LoadingController, type LoadingPhase } from './createLoadingController.js';
import type { ResolutionTrace } from './startResolutionTrace.js';
import { createStateMachine, nest, realTimers, type MachineTypes, type Timers, type Transition } from '@dotli/shared';
import { createReporter, defineCount } from '@dotli/metrics';
import { productState } from './runtime/state/productState.js';
import { networkMonitorState, type ChainPhase } from './state/networkMonitorState.js';
import { createChainPhaseTracker } from './createChainPhaseTracker.js';
import { getChainTelemetryName } from './getChainTelemetryName.js';
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
  timers?: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>;
  /** The monotonic clock the load's age and download rate are measured on, in milliseconds. The page's by default. */
  now?: () => number;
  /** Where the load's chain events go. The page's bus by default. */
  debugBus?: DebugBus;
};

type CreateChainReporterParams = Required<Pick<Params, 'flowId' | 'timers' | 'debugBus'>>;

type CreateThroughputMeterParams = {
  /** The monotonic clock, in milliseconds. */
  readClock: NonNullable<Params['now']>;
};

/**
 * The slow-load warning. Once shown, it stays and only its text updates, since a blinking row reads as worse trouble.
 * An early condition is parked until the load is old enough to be slow.
 */
type Warning = { kind: 'hidden' } | { kind: 'pending'; message: string; timer: unknown } | { kind: 'shown' };

/** What a critical chain's stall message reads, kept across its watches. */
type StallFacts = { peers: number | null; reason: string | undefined };

/**
 * One critical chain's stall watch. Every lifecycle event re-arms it, so a chain warns only when it sits in one state
 * past the threshold.
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

/** A gateway has no chains to follow, so only the resolver's phases move its bar. */
type ChainFollow =
  | { kind: 'gateway' }
  | {
      kind: 'lightClient';
      warning: Warning;
      // Per chain, since one figure would blank to zero at every handover.
      watches: ReadonlyMap<CriticalChain, StallWatch>;
      byteTotals: ByteTotals;
    };

type LightClientFollow = Extract<ChainFollow, { kind: 'lightClient' }>;

type ProgressState =
  { kind: 'idle' } | { kind: 'following'; stops: readonly (() => void)[]; chains: ChainFollow } | { kind: 'disposed' };

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
  | { kind: 'chainStalled'; message: string }
  | { kind: 'warningDue'; timer: unknown }
  | { kind: 'disposed' };

type ProgressMachine = MachineTypes<ProgressState, ProgressEvent>;

type ChainFollowMachine = MachineTypes<ChainFollow, ProgressEvent>;

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
 * resolved. Never throws: a throw of a subscription in `events` is reported, and the load then moves no bar.
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
  // Always the last band.
  const contentFetchPhase = gateway ? 2 : 3;
  const loadStartedAt = readClock();
  const chainReporter = createChainReporter({ flowId, timers, debugBus });
  const throughput = createThroughputMeter({ readClock });

  const handleWatch = nest<ChainFollowMachine, 'lightClient', MachineTypes<StallWatch, ProgressEvent>, 'stallDue'>({
    find: ({ watches }, { chain }) => watches.get(chain) ?? null,
    store: (follow, { chain }, next) => ({ ...follow, watches: new Map(follow.watches).set(chain, next) }),
    handlers: {
      quiet: null,
      watching: {
        stallDue(watch, { chain, timer }, { emitState, update }) {
          // A timer of a watch since re-armed or quieted warns of nothing.
          if (timer !== watch.timer) {
            return;
          }
          const facts: StallFacts = { peers: watch.peers, reason: watch.reason };
          const message = describeStall({ chain, bytesPerSecond: throughput.readBytesPerSecond(), ...facts });
          if (message === null) {
            emitState({ kind: 'quiet', ...facts });
            return;
          }
          emitState({ kind: 'warned', ...facts });
          update({ kind: 'chainStalled', message });
        },
      },
      warned: null,
    },
  });
  const handleByteTotals = nest<
    ChainFollowMachine,
    'lightClient',
    MachineTypes<ByteTotals, ProgressEvent>,
    'netBytes' | 'productLoaded'
  >({
    find: ({ byteTotals }) => byteTotals,
    store: (follow, _event, byteTotals) => ({ ...follow, byteTotals }),
    handlers: {
      open: {
        netBytes(totals, { received }, { emitState }) {
          const now = timers.now();
          if (
            totals.samples >= CHAIN_BYTES_DEBUG_MAX ||
            received === totals.lastTotal ||
            now - totals.lastAt < CHAIN_BYTES_DEBUG_MS
          ) {
            emitState({ ...totals, latest: received });
            return;
          }
          emitState({ kind: 'open', latest: received, lastAt: now, lastTotal: received, samples: totals.samples + 1 });
          emitByteTotal(received, now);
        },
        productLoaded(totals, _event, { emitState }) {
          emitState({ kind: 'closed' });
          if (totals.latest !== totals.lastTotal) {
            emitByteTotal(totals.latest, timers.now());
          }
        },
      },
      closed: null,
    },
  });
  // The light client's lifecycle milestones drive the bar, wherever it runs.
  const followChains = nest<
    ProgressMachine,
    'following',
    ChainFollowMachine,
    | 'chainSynced'
    | 'netBytes'
    | 'contentProgressed'
    | 'barStalled'
    | 'productLoaded'
    | 'phaseResolved'
    | 'stallDue'
    | 'chainStalled'
    | 'warningDue'
  >({
    find: ({ chains }) => chains,
    store: (state, _event, chains) => ({ ...state, chains }),
    handlers: {
      gateway: null,
      lightClient: {
        chainSynced(follow, { sync }, transition) {
          watchChain(follow, sync, transition);
          chainReporter.record(sync);
          moveBarOnChainSync(sync, loading);
        },
        netBytes(follow, event, transition) {
          handleByteTotals(follow, event, transition);
          throughput.record(event.received);
        },
        contentProgressed(_follow, { bytesFetched, totalBytes }) {
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
        barStalled(follow, _event, transition) {
          // A chain whose stall warned names the cause, so a parked bar does not replace its line.
          const message = describeProgressStall(throughput.readBytesPerSecond());
          if (message === null || hasWarnedWatch(follow.watches)) {
            return;
          }
          showWarning(follow, message, transition);
        },
        productLoaded: handleByteTotals,
        phaseResolved(_follow, { phase }) {
          const index = PHASE_INDEX[phase];
          if (index !== undefined) {
            loading.advancePhase(index);
          }
        },
        stallDue: handleWatch,
        chainStalled(follow, { message }, transition) {
          showWarning(follow, message, transition);
        },
        warningDue(follow, { timer }, transition) {
          // A timer of a warning since shown or dropped shows nothing.
          if (follow.warning.kind !== 'pending' || follow.warning.timer !== timer) {
            return;
          }
          revealWarning(follow, follow.warning.message, transition);
        },
      },
    },
  });
  const progress = createStateMachine<ProgressMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, { emitState, update }) {
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
            for (const stop of stops) {
              try {
                stop();
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
          emitState({
            kind: 'following',
            stops,
            chains: gateway
              ? { kind: 'gateway' }
              : {
                  kind: 'lightClient',
                  warning: { kind: 'hidden' },
                  watches: new Map(),
                  byteTotals: { kind: 'open', latest: 0, lastAt: 0, lastTotal: -1, samples: 0 },
                },
          });
        },
      },
      following: {
        chainSynced(state, event, transition) {
          trace.recordChainSync(event.sync);
          followChains(state, event, transition);
        },
        chainDetailed(_state, { detail }) {
          trace.recordChainDetail(detail);
          if (detail.dbCache !== undefined) {
            debugBus.emit({
              layer: 'chain',
              event: 'dbcache',
              flowId,
              timestamp: timers.now(),
              payload: { chain: detail.chain, dbCache: detail.dbCache },
            });
          }
        },
        netBytes(state, event, transition) {
          trace.recordBytes(event.received);
          followChains(state, event, transition);
        },
        contentProgressed(state, event, transition) {
          // Records before it moves the bar, so the record sees the bar unmoved.
          trace.recordContent(event.bytesFetched, event.totalBytes);
          followChains(state, event, transition);
        },
        barStalled: followChains,
        productLoaded: followChains,
        phaseResolved: followChains,
        nameResolved() {
          loading.stopStatusTick();
        },
        contentFetchEntered() {
          loading.advancePhase(contentFetchPhase);
        },
        stallDue: followChains,
        chainStalled: followChains,
        warningDue: followChains,
        disposed({ stops, chains }, _event, { emitState }) {
          emitState({ kind: 'disposed' });
          switch (chains.kind) {
            case 'gateway':
              break;
            case 'lightClient':
              for (const watch of chains.watches.values()) {
                if (watch.kind === 'watching') {
                  timers.clearTimeout(watch.timer);
                }
              }
              if (chains.warning.kind === 'pending') {
                timers.clearTimeout(chains.warning.timer);
              }
              break;
          }
          for (const stop of stops) {
            stop();
          }
        },
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

  loading.initPhases(getLoadingPhases(backend));
  loading.setLoadingDomain(label);
  loading.advancePhase(0);
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
     * Stops hearing the load's reports, the product store and the loading screen's stalls, and clears the warnings'
     * timers. Repeating it does nothing. Never throws: a throw of an unsubscribe in `events` is reported.
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
  function watchChain(
    follow: LightClientFollow,
    sync: ChainSyncEvent,
    transition: Transition<ChainFollowMachine>,
  ): void {
    const { chain } = sync;
    if (!isCriticalChain(chain)) {
      return;
    }
    const watch: StallWatch = follow.watches.get(chain) ?? { kind: 'quiet', peers: null, reason: undefined };
    // A health sample arrives every second, so it never re-arms the watch, or a stalled chain would never warn.
    if (sync.kind === 'peers') {
      if (sync.peers !== undefined) {
        transition.emitState({
          ...follow,
          watches: new Map(follow.watches).set(chain, { ...watch, peers: sync.peers }),
        });
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
    const watched: LightClientFollow = { ...follow, watches: new Map(follow.watches).set(chain, next) };
    transition.emitState(watched);
    if (watch.kind === 'watching') {
      timers.clearTimeout(watch.timer);
    }
    if (watch.kind !== 'warned' || hasWarnedWatch(watched.watches)) {
      return;
    }
    // Recovered, but hiding the row would flash it, so fall back to the general slow-load line.
    switch (follow.warning.kind) {
      case 'hidden':
        return;
      case 'pending':
        transition.emitState({ ...watched, warning: { kind: 'hidden' } });
        timers.clearTimeout(follow.warning.timer);
        return;
      case 'shown':
        showWarning(watched, describeProgressStall(throughput.readBytesPerSecond()) ?? STILL_WORKING, transition);
        return;
    }
  }

  /** Shows `message` as the slow-load warning, or parks it until the load is old enough to be slow. */
  function showWarning(follow: LightClientFollow, message: string, transition: Transition<ChainFollowMachine>): void {
    const waitLeft = WARNING_MIN_LOAD_MS - (readClock() - loadStartedAt);
    if (waitLeft <= 0) {
      revealWarning(follow, message, transition);
      return;
    }
    // A later message replaces the parked one, and the parked one's timer shows it.
    if (follow.warning.kind === 'pending') {
      transition.emitState({ ...follow, warning: { ...follow.warning, message } });
      return;
    }
    const timer = timers.setTimeout(() => {
      transition.update({ kind: 'warningDue', timer });
    }, waitLeft);
    transition.emitState({ ...follow, warning: { kind: 'pending', message, timer } });
  }

  /** Shows `message` as the slow-load warning at once, in place of a parked one. */
  function revealWarning(
    follow: LightClientFollow,
    message: string,
    { emitState }: Transition<ChainFollowMachine>,
  ): void {
    emitState({ ...follow, warning: { kind: 'shown' } });
    if (follow.warning.kind === 'pending') {
      timers.clearTimeout(follow.warning.timer);
    }
    trace.markWarningShown();
    loading.setLoadingWarning(message);
  }

  function emitByteTotal(received: number, at: number): void {
    debugBus.emit({ layer: 'chain', event: 'bytes', flowId, timestamp: at, payload: { received } });
  }
}

/** Returns whether a critical chain's stall gave the warning. Never throws. */
function hasWarnedWatch(watches: LightClientFollow['watches']): boolean {
  return [...watches.values()].some(watch => watch.kind === 'warned');
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
      report.log.event(`${getChainTelemetryName(event.chain)} ${phase}`, {
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
