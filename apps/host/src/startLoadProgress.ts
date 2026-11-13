// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what the light client and the content fetch report into the loading bar, its slow-load warnings, the network
// monitor and the debug panel's chain events. The reports come from other frames, so they are passed in.

import { hasLightClient, type Backend } from '@dotli/config';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import type { ResolvePhase } from '@dotli/resolver';
import { debugBus as pageDebugBus, type DebugBus } from '@dotli/truapi-debug';
import { pageLoading, type LoadingController } from './createLoadingController.js';
import {
  getLoadingBands,
  moveBarOnChainSync,
  moveBarOnContentProgress,
  moveBarOnResolvePhase,
} from './loadingBands.js';
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
import {
  describeProgressStall,
  describeStall,
  isCriticalChain,
  type CriticalChain,
  type StallFacts,
} from './warnings.js';
import { STILL_WORKING } from './stillWorking.js';

const report = createReporter({ flow: 'chain' });
const loadProgressTransitionMetric = defineCount<'error'>('load_progress.transition');

export type ContentProgressFacts = {
  bytesFetched: number;
  totalBytes: number | null;
};

/** Where the load's reports come from: the protocol frame and the sandbox's content fetch. Each returns its unsubscribe. */
export type LoadEvents = {
  /** Calls `listener` with each chain's lifecycle milestones. Never throws. */
  onChainSync: (listener: (event: ChainSyncEvent) => void) => () => void;
  /** Calls `listener` with each chain's details. Never throws. */
  onChainDetail: (listener: (event: ChainDetail) => void) => () => void;
  /** Calls `listener` with the load's byte total so far. Never throws. */
  onNetBytes: (listener: (event: { received: number }) => void) => () => void;
  /** Calls `listener` with the content fetch's progress. Never throws. */
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
type LoadTrace = Pick<
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

/**
 * What a critical chain's stall message reads, kept across its watches, and whether the shown line is this chain's.
 */
type WatchFacts = Pick<StallFacts, 'peers' | 'reason'> & { warned: boolean };

/**
 * One critical chain's stall watch. Every lifecycle event re-arms it, so a chain warns only when it sits in one state
 * past the threshold. A watch's timer warns only while that watch is still the chain's.
 */
type StallWatch = ({ kind: 'quiet' } & WatchFacts) | ({ kind: 'watching'; timer: unknown } & WatchFacts);

/**
 * The sampled report of the load's byte totals to the debug panel, on the load's clock. It closes once the product is
 * on screen, or it pushes the load's own events out of the panel's ring buffer.
 */
type ByteTotals =
  | { kind: 'open'; received: number; sampled: { at: number; total: number } | null; samples: number }
  | { kind: 'closed' };

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
      /** When the load started, on the monotonic clock, which a warning waits on. */
      startedAt: number;
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

/** What the machine decides from its state: a warning to show, a rate it measured, a byte total it sampled. */
type ProgressEffect =
  | { kind: 'warningShown'; message: string }
  | { kind: 'rateMeasured'; bytesPerSecond: number }
  | { kind: 'byteTotalSampled'; received: number };

type ProgressMachine = MachineTypes<ProgressState, ProgressEvent, ProgressEffect>;

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
  const phases = getLoadingBands(backend);
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
    stopEach(stops);
  };
  const progress = createStateMachine<ProgressMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, { emitState, update }) {
          loading.initPhases(phases);
          loading.setLoadingDomain(label);
          loading.advancePhase(0);
          const stops: (() => void)[] = [];
          // A subscription that throws leaves none of the others behind, as the progress then stays idle.
          try {
            // Pushed one by one, so each stop is kept before the next subscription can throw. On every backend: a
            // gateway trace with no chain events is the point, not a gap.
            stops.push(
              events.onChainSync(sync => {
                update({ kind: 'chainSynced', sync });
              }),
            );
            stops.push(
              events.onChainDetail(detail => {
                update({ kind: 'chainDetailed', detail });
              }),
            );
            stops.push(
              events.onNetBytes(({ received }) => {
                update({ kind: 'netBytes', received });
              }),
            );
            stops.push(
              events.onContentProgress(facts => {
                update({ kind: 'contentProgressed', ...facts });
              }),
            );
            if (!hasLightClient(backend)) {
              emitState({ kind: 'gateway', stops });
              return;
            }
            stops.push(
              loading.onProgressStall(() => {
                update({ kind: 'barStalled' });
              }),
            );
            stops.push(
              productState.store.listen(product => {
                if (product.status === 'loaded') {
                  update({ kind: 'productLoaded' });
                }
              }),
            );
          } catch (error) {
            stopEach(stops);
            throw error;
          }
          emitState({
            kind: 'lightClient',
            stops,
            startedAt: readClock(),
            warning: { kind: 'hidden' },
            watches: new Map(),
            byteTotals: { kind: 'open', received: 0, sampled: null, samples: 0 },
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
        netBytes(state, { received }, { emitState, emitSideEffect }) {
          const at = readClock();
          const throughput = measureThroughput(state.throughput, received, at);
          const { byteTotals } = state;
          if (byteTotals.kind === 'closed') {
            emitState({ ...state, throughput });
          } else if (
            byteTotals.samples >= CHAIN_BYTES_DEBUG_MAX ||
            (byteTotals.sampled !== null &&
              (received === byteTotals.sampled.total || at - byteTotals.sampled.at < CHAIN_BYTES_DEBUG_MS))
          ) {
            emitState({ ...state, throughput, byteTotals: { ...byteTotals, received } });
          } else {
            // A new total is sampled a second after the last, up to the cap.
            const samples = byteTotals.samples + 1;
            emitState({
              ...state,
              throughput,
              byteTotals: { kind: 'open', received, sampled: { at, total: received }, samples },
            });
            emitSideEffect({ kind: 'byteTotalSampled', received });
          }
          trace.recordBytes(received);
          if (throughput.bytesPerSecond !== null) {
            emitSideEffect({ kind: 'rateMeasured', bytesPerSecond: throughput.bytesPerSecond });
          }
        },
        contentProgressed(_state, { bytesFetched, totalBytes }) {
          // Records before it moves the bar, so the record sees the bar unmoved.
          trace.recordContent(bytesFetched, totalBytes);
          // Every block the sandbox needs passes through this window, measured against the total the DAG root declares.
          networkMonitorState.recordTransfer({ fetched: bytesFetched, total: totalBytes });
          moveBarOnContentProgress(bytesFetched, totalBytes, loading);
        },
        barStalled(state, _event, transition) {
          // A chain whose stall warned names the cause, so a parked bar does not replace its line.
          const message = describeProgressStall(state.throughput.bytesPerSecond);
          if (message === null || hasWarnedWatch(state.watches)) {
            return;
          }
          showWarning(state, message, transition);
        },
        productLoaded(state, _event, { emitState, emitSideEffect }) {
          const totals = state.byteTotals;
          if (totals.kind === 'closed') {
            return;
          }
          emitState({ ...state, byteTotals: { kind: 'closed' } });
          if (totals.received !== totals.sampled?.total) {
            emitSideEffect({ kind: 'byteTotalSampled', received: totals.received });
          }
        },
        phaseResolved(_state, { phase }) {
          moveBarOnResolvePhase(phase, loading);
        },
        nameResolved: holdBar,
        contentFetchEntered: enterContentBand,
        stallDue(state, { chain, timer }, transition) {
          const watch = state.watches.get(chain);
          // A timer of a watch since re-armed or quieted warns of nothing.
          if (watch?.kind !== 'watching' || watch.timer !== timer) {
            return;
          }
          const { peers, reason, warned } = watch;
          const message = describeStall({ chain, bytesPerSecond: state.throughput.bytesPerSecond, peers, reason });
          if (message === null) {
            transition.emitState(withWatch(state, chain, { kind: 'quiet', peers, reason, warned }));
            return;
          }
          showWarning(withWatch(state, chain, { kind: 'quiet', peers, reason, warned: true }), message, transition);
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
    onEffect: effect => {
      switch (effect.kind) {
        case 'warningShown':
          trace.markWarningShown();
          loading.setLoadingWarning(effect.message);
          return;
        case 'rateMeasured':
          networkMonitorState.recordTransfer({ bytesPerSecond: effect.bytesPerSecond });
          return;
        case 'byteTotalSampled':
          debugBus.emit({
            layer: 'chain',
            event: 'bytes',
            flowId,
            timestamp: timers.now(),
            payload: { received: effect.received },
          });
          return;
      }
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
    const watch: StallWatch = state.watches.get(chain) ?? {
      kind: 'quiet',
      peers: null,
      reason: undefined,
      warned: false,
    };
    // A health sample arrives every second, so it never re-arms the watch, or a stalled chain would never warn.
    if (sync.kind === 'peers') {
      if (sync.peers !== undefined) {
        transition.emitState(withWatch(state, chain, { ...watch, peers: sync.peers }));
      }
      return;
    }
    const facts: WatchFacts = {
      peers: watch.peers,
      reason: sync.kind === 'stalled' ? sync.reason : undefined,
      // A chain that stalls or reconnects again has not recovered, so its line stays until its watch words it afresh.
      warned: watch.warned && (sync.kind === 'stalled' || sync.kind === 'connecting'),
    };
    let next: StallWatch = { kind: 'quiet', ...facts };
    if (sync.kind !== 'bootstrapComplete') {
      const timer = timers.setTimeout(() => {
        transition.update({ kind: 'stallDue', chain, timer });
      }, STALL_WARNING_MS);
      next = { kind: 'watching', timer, ...facts };
    }
    const watched = withWatch(state, chain, next);
    if (!watch.warned || facts.warned || hasWarnedWatch(watched.watches)) {
      transition.emitState(watched);
      return;
    }
    // Recovered. A parked line was never seen, so it goes.
    if (state.warning.kind === 'pending') {
      transition.emitState({ ...watched, warning: { kind: 'hidden' } });
      return;
    }
    // Hiding the shown row would flash it, so fall back to the general slow-load line. It is past the minimum load age
    // already.
    revealWarning(watched, describeProgressStall(state.throughput.bytesPerSecond) ?? STILL_WORKING, transition);
  }

  /** Shows `message` as the slow-load warning, or parks it until the load is old enough to be slow. */
  function showWarning(state: LightClientState, message: string, transition: Transition<ProgressMachine>): void {
    const waitLeft = WARNING_MIN_LOAD_MS - (readClock() - state.startedAt);
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
  function revealWarning(
    state: LightClientState,
    message: string,
    { emitState, emitSideEffect }: Transition<ProgressMachine>,
  ): void {
    emitState({ ...state, warning: { kind: 'shown' } });
    emitSideEffect({ kind: 'warningShown', message });
  }
}

/** Calls every stop, so one that throws is reported and leaves none of the others listening. */
function stopEach(stops: readonly (() => void)[]): void {
  for (const stopListening of stops) {
    try {
      stopListening();
    } catch (error) {
      report.defect(error, {
        step: 'transition',
        metric: loadProgressTransitionMetric,
        message: '[dot.li] A load progress unsubscribe threw',
      });
    }
  }
}

/** `state` with `chain`'s stall watch replaced by `watch`. */
function withWatch(state: LightClientState, chain: CriticalChain, watch: StallWatch): LightClientState {
  return { ...state, watches: new Map(state.watches).set(chain, watch) };
}

/** Returns whether a critical chain's stall gave the warning. */
function hasWarnedWatch(watches: LightClientState['watches']): boolean {
  return [...watches.values()].some(watch => watch.warned);
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
