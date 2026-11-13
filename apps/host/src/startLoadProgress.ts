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
  moveBarToDownload,
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

/** A slow-load line, and the critical chain whose stall it describes, or `null` for the general line. */
type WarningLine = { message: string; chain: CriticalChain | null };

/**
 * The slow-load warning. Early warnings read as failure on loads that would succeed, so until the load is old enough to
 * be slow the latest line is parked, and shown at that mark if it still stands. Once shown, the warning stays and only
 * its text updates, since a blinking row reads as worse trouble.
 */
type Warning =
  { kind: 'early'; parked: WarningLine | null } | { kind: 'hidden' } | { kind: 'shown'; chain: CriticalChain | null };

/** What a critical chain's stall message reads, kept across its watches. */
type WatchFacts = Pick<StallFacts, 'peers' | 'reason'>;

/**
 * One critical chain's stall watch. Every lifecycle event re-arms it, so a chain warns only when it sits in one state
 * past the threshold. A stall timer warns only while it is still the timer of the chain's watch.
 */
type StallWatch = ({ kind: 'quiet' } & WatchFacts) | ({ kind: 'watching'; timer: unknown } & WatchFacts);

/** A byte total and when it was taken, on the load's clock. */
type ByteSample = { at: number; total: number };

/**
 * The sampled report of the load's byte totals to the debug panel. It closes once the product is on screen, or it
 * pushes the load's own events out of the panel's ring buffer.
 */
type ByteTotals = { kind: 'open'; received: number; sampled: ByteSample | null; samples: number } | { kind: 'closed' };

/** The whole load's throughput over a trailing window. */
type Throughput = { samples: readonly ByteSample[]; bytesPerSecond: number | null };

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
  | { kind: 'netBytes'; received: number; at: number }
  | ({ kind: 'contentProgressed' } & ContentProgressFacts)
  | { kind: 'barStalled' }
  | { kind: 'productLoaded' }
  | { kind: 'phaseResolved'; phase: ResolvePhase }
  | { kind: 'nameResolved' }
  | { kind: 'contentFetchEntered' }
  | { kind: 'stallDue'; chain: CriticalChain; timer: unknown }
  | { kind: 'slowMarkReached' }
  | { kind: 'disposed' };

/** What the load tells its outputs. */
type ProgressEffect =
  | { kind: 'barOpened' }
  | { kind: 'chainSyncRecorded'; sync: ChainSyncEvent }
  | { kind: 'chainSyncShown'; sync: ChainSyncEvent }
  | { kind: 'chainDetailRecorded'; detail: ChainDetail }
  | { kind: 'bytesRecorded'; received: number }
  | { kind: 'byteTotalSampled'; received: number }
  | { kind: 'rateMeasured'; bytesPerSecond: number }
  | ({ kind: 'contentRecorded' } & ContentProgressFacts)
  | ({ kind: 'contentShown' } & ContentProgressFacts)
  | { kind: 'barMovedToPhase'; phase: ResolvePhase }
  | { kind: 'barHeld' }
  | { kind: 'barMovedToDownload' }
  | { kind: 'warningShown'; message: string };

type ProgressMachine = MachineTypes<ProgressState, ProgressEvent, ProgressEffect>;

// Every other 500ms byte total, which still resolves the peak.
const CHAIN_BYTES_DEBUG_MS = 1000;
/** For a load that never renders. */
const CHAIN_BYTES_DEBUG_MAX = 300;
const SPEED_WINDOW_MS = 3_000;

/** How long a chain may sit in one lifecycle state before it owes an explanation. */
const STALL_WARNING_MS = 3_000;

/** How old a load must be before it reads as slow. */
const WARNING_MIN_LOAD_MS = 5_000;

const UNWATCHED: StallWatch = { kind: 'quiet', peers: null, reason: undefined };

/**
 * Starts the bar for one load and returns what moves it. Call it once the label is known and before anything is
 * resolved. Never throws: a throw of the loading screen or of a subscription in `events` is reported. A load whose
 * subscription threw opens its bar and moves it no further.
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
  const bands = getLoadingBands(backend);
  const chainReporter = createChainReporter({ flowId, timers, debugBus });
  const recordDetail: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'chainDetailed'> = (
    _state,
    { detail },
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'chainDetailRecorded', detail });
  };
  const holdBar: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'nameResolved'> = (
    _state,
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'barHeld' });
  };
  const enterDownload: HandlerOf<ProgressMachine, 'gateway' | 'lightClient', 'contentFetchEntered'> = (
    _state,
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'barMovedToDownload' });
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
        started(_state, _event, { emitState, emitSideEffect, update }) {
          emitSideEffect({ kind: 'barOpened' });
          // On every backend: a gateway trace with no chain events is the point, not a gap.
          const reports = [
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
                update({ kind: 'netBytes', received, at: readClock() });
              }),
            () =>
              events.onContentProgress(facts => {
                update({ kind: 'contentProgressed', ...facts });
              }),
          ];
          if (!hasLightClient(backend)) {
            emitState({ kind: 'gateway', stops: subscribeEach(reports) });
            return;
          }
          const stops = subscribeEach([
            ...reports,
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
          ]);
          emitState({
            kind: 'lightClient',
            stops,
            warning: { kind: 'early', parked: null },
            watches: new Map(),
            byteTotals: { kind: 'open', received: 0, sampled: null, samples: 0 },
            // Seeded with page start, so the first report already has a reading to measure against.
            throughput: { samples: [{ at: 0, total: 0 }], bytesPerSecond: null },
          });
          timers.setTimeout(() => {
            update({ kind: 'slowMarkReached' });
          }, WARNING_MIN_LOAD_MS);
        },
      },
      gateway: {
        chainSynced(_state, { sync }, { emitSideEffect }) {
          emitSideEffect({ kind: 'chainSyncRecorded', sync });
        },
        chainDetailed: recordDetail,
        netBytes(_state, { received }, { emitSideEffect }) {
          emitSideEffect({ kind: 'bytesRecorded', received });
        },
        contentProgressed(_state, facts, { emitSideEffect }) {
          emitSideEffect({ ...facts, kind: 'contentRecorded' });
        },
        nameResolved: holdBar,
        contentFetchEntered: enterDownload,
        disposed: stop,
      },
      lightClient: {
        chainSynced(state, { sync }, transition) {
          // Records before it moves the bar, so the record sees the bar unmoved.
          transition.emitSideEffect({ kind: 'chainSyncRecorded', sync });
          transition.emitSideEffect({ kind: 'chainSyncShown', sync });
          watchChain(state, sync, transition);
        },
        chainDetailed: recordDetail,
        netBytes(state, { received, at }, { emitState, emitSideEffect }) {
          const throughput = measureThroughput(state.throughput, received, at);
          const totals = state.byteTotals;
          emitSideEffect({ kind: 'bytesRecorded', received });
          if (totals.kind === 'closed') {
            emitState({ ...state, throughput });
          } else if (isByteTotalDue(totals, received, at)) {
            const sampled = { at, total: received };
            emitState({
              ...state,
              throughput,
              byteTotals: { ...totals, received, sampled, samples: totals.samples + 1 },
            });
            emitSideEffect({ kind: 'byteTotalSampled', received });
          } else {
            emitState({ ...state, throughput, byteTotals: { ...totals, received } });
          }
          if (throughput.bytesPerSecond !== null) {
            emitSideEffect({ kind: 'rateMeasured', bytesPerSecond: throughput.bytesPerSecond });
          }
        },
        contentProgressed(_state, facts, { emitSideEffect }) {
          // Records before it moves the bar, so the record sees the bar unmoved.
          emitSideEffect({ ...facts, kind: 'contentRecorded' });
          emitSideEffect({ ...facts, kind: 'contentShown' });
        },
        barStalled(state, _event, transition) {
          // A line that names a stalled chain names the cause, so a parked bar does not replace it.
          const message = describeProgressStall(state.throughput.bytesPerSecond);
          if (message === null || getWarnedChain(state.warning) !== null) {
            return;
          }
          raiseWarning(state, { message, chain: null }, transition);
        },
        productLoaded(state, _event, { emitState, emitSideEffect }) {
          const { byteTotals } = state;
          if (byteTotals.kind === 'closed') {
            return;
          }
          emitState({ ...state, byteTotals: { kind: 'closed' } });
          // No report at all leaves nothing unsampled.
          if (byteTotals.sampled !== null && byteTotals.received !== byteTotals.sampled.total) {
            emitSideEffect({ kind: 'byteTotalSampled', received: byteTotals.received });
          }
        },
        phaseResolved(_state, { phase }, { emitSideEffect }) {
          emitSideEffect({ kind: 'barMovedToPhase', phase });
        },
        nameResolved: holdBar,
        contentFetchEntered: enterDownload,
        stallDue(state, { chain, timer }, transition) {
          const watch = state.watches.get(chain);
          // A timer of a watch since re-armed or quieted warns of nothing.
          if (watch?.kind !== 'watching' || watch.timer !== timer) {
            return;
          }
          const { peers, reason } = watch;
          const quieted = withWatch(state, chain, { kind: 'quiet', peers, reason });
          const message = describeStall({ chain, bytesPerSecond: state.throughput.bytesPerSecond, peers, reason });
          if (message === null) {
            transition.emitState(quieted);
            return;
          }
          raiseWarning(quieted, { message, chain }, transition);
        },
        slowMarkReached(state, _event, transition) {
          // Only the early warning waits on the mark, and the mark is reached once.
          if (state.warning.kind !== 'early') {
            return;
          }
          if (state.warning.parked === null) {
            transition.emitState({ ...state, warning: { kind: 'hidden' } });
            return;
          }
          revealWarning(state, state.warning.parked, transition);
        },
        disposed: stop,
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'barOpened':
          loading.initPhases(bands);
          loading.setLoadingDomain(label);
          loading.advancePhase(0);
          return;
        case 'chainSyncRecorded':
          trace.recordChainSync(effect.sync);
          return;
        case 'chainSyncShown':
          chainReporter.record(effect.sync);
          moveBarOnChainSync(effect.sync, loading);
          return;
        case 'chainDetailRecorded':
          trace.recordChainDetail(effect.detail);
          chainReporter.recordDetail(effect.detail);
          return;
        case 'bytesRecorded':
          trace.recordBytes(effect.received);
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
        case 'rateMeasured':
          networkMonitorState.recordTransfer({ bytesPerSecond: effect.bytesPerSecond });
          return;
        case 'contentRecorded':
          trace.recordContent(effect.bytesFetched, effect.totalBytes);
          return;
        case 'contentShown':
          // Every block the sandbox needs passes through this window, measured against the total the DAG root declares.
          networkMonitorState.recordTransfer({ fetched: effect.bytesFetched, total: effect.totalBytes });
          moveBarOnContentProgress(effect.bytesFetched, effect.totalBytes, loading);
          return;
        case 'barMovedToPhase':
          moveBarOnResolvePhase(effect.phase, loading);
          return;
        case 'barHeld':
          loading.stopStatusTick();
          return;
        case 'barMovedToDownload':
          moveBarToDownload(bands, loading);
          return;
        case 'warningShown':
          trace.markWarningShown();
          loading.setLoadingWarning(effect.message);
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
   * Re-arms a critical chain's stall watch on its lifecycle milestone, or keeps a peer sample for the wording. When the
   * chain the line names recovers, its line gives way to the general one, even while another chain still stalls.
   */
  function watchChain(state: LightClientState, sync: ChainSyncEvent, transition: Transition<ProgressMachine>): void {
    const { chain } = sync;
    if (!isCriticalChain(chain)) {
      return;
    }
    const watch = state.watches.get(chain) ?? UNWATCHED;
    // A health sample arrives every second, so it never re-arms the watch, or a stalled chain would never warn.
    if (sync.kind === 'peers') {
      if (sync.peers !== undefined) {
        transition.emitState(withWatch(state, chain, { ...watch, peers: sync.peers }));
      }
      return;
    }
    const { peers } = watch;
    const reason = sync.kind === 'stalled' ? sync.reason : undefined;
    // A chain whose boot completed has nothing left to stall on.
    const watched = withWatch(
      state,
      chain,
      sync.kind === 'bootstrapComplete'
        ? { kind: 'quiet', peers, reason }
        : { kind: 'watching', timer: startStallTimer(chain, transition), peers, reason },
    );
    // Only the named chain moving on takes its line down. One that stalls or reconnects again keeps its line until its
    // watch words it afresh.
    const recovered = sync.kind !== 'stalled' && sync.kind !== 'connecting' && getWarnedChain(state.warning) === chain;
    if (!recovered) {
      transition.emitState(watched);
      return;
    }
    // A parked line was never seen, so it goes.
    if (state.warning.kind === 'early') {
      transition.emitState({ ...watched, warning: { kind: 'early', parked: null } });
      return;
    }
    // Hiding the shown row would flash it, so fall back to the general slow-load line.
    const message = describeProgressStall(state.throughput.bytesPerSecond) ?? STILL_WORKING;
    revealWarning(watched, { message, chain: null }, transition);
  }

  /** Starts `chain`'s stall timer and returns it as the token its watch keeps. */
  function startStallTimer(chain: CriticalChain, { update }: Transition<ProgressMachine>): unknown {
    // The token is the timer, not the watch: a peer sample replaces the watch and must keep its timer running.
    const timer = timers.setTimeout(() => {
      update({ kind: 'stallDue', chain, timer });
    }, STALL_WARNING_MS);
    return timer;
  }
}

/** Shows `line` as the slow-load warning, or parks it in place of any parked line until the load is old enough to be slow. */
function raiseWarning(state: LightClientState, line: WarningLine, transition: Transition<ProgressMachine>): void {
  if (state.warning.kind === 'early') {
    transition.emitState({ ...state, warning: { kind: 'early', parked: line } });
    return;
  }
  revealWarning(state, line, transition);
}

/** Shows `line` as the slow-load warning at once. */
function revealWarning(
  state: LightClientState,
  { message, chain }: WarningLine,
  { emitState, emitSideEffect }: Transition<ProgressMachine>,
): void {
  emitState({ ...state, warning: { kind: 'shown', chain } });
  emitSideEffect({ kind: 'warningShown', message });
}

/** The critical chain whose stall the warning's line describes, or `null` for the general line or none. */
function getWarnedChain(warning: Warning): CriticalChain | null {
  switch (warning.kind) {
    case 'early':
      return warning.parked?.chain ?? null;
    case 'hidden':
      return null;
    case 'shown':
      return warning.chain;
  }
}

/**
 * Takes each subscription in order and returns their stops.
 *
 * @throws What a subscription throws, once the stops of those before it have run.
 */
function subscribeEach(subscriptions: readonly (() => () => void)[]): (() => void)[] {
  const stops: (() => void)[] = [];
  try {
    for (const subscribe of subscriptions) {
      stops.push(subscribe());
    }
  } catch (error) {
    stopEach(stops);
    throw error;
  }
  return stops;
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

/**
 * Returns whether the open report samples `received`, the load's byte total, at `at`: a new total a second after the
 * last one, up to the cap.
 */
function isByteTotalDue(
  { sampled, samples }: Extract<ByteTotals, { kind: 'open' }>,
  received: number,
  at: number,
): boolean {
  return (
    samples < CHAIN_BYTES_DEBUG_MAX &&
    (sampled === null || (received !== sampled.total && at - sampled.at >= CHAIN_BYTES_DEBUG_MS))
  );
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
