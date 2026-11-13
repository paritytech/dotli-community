// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what happened to a product load into its reports, in the order the load tells it.

import type { SandboxBlockRelay } from '@dotli/bitswap';
import { getNetwork, hasLightClient, withActiveTld, type Backend } from '@dotli/config';
import { createReporter, defineCount, m, type SpanHandle } from '@dotli/metrics';
import { getProtocolClient, type ProtocolClient } from '@dotli/protocol';
import type { ResolvePhase } from '@dotli/resolver';
import { isLoadedOutcome } from '@dotli/sandbox-wire';
import {
  createRandomId,
  createStateMachine,
  formatDuration,
  formatElapsed,
  getErrorMessage,
  log,
  realTimers,
  serializeError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { debugBus as pageDebugBus, type DebugBus } from '@dotli/truapi-debug';
import type { ProductManifests } from './cachedManifest.js';
import { cacheReadMetric } from './cacheReadMetric.js';
import type { ErrorDescription } from './describeError.js';
import { beginAttempt, endJourney, type Attempt } from './journey.js';
import { readPageClock } from './readPageClock.js';
import { startLoadProgress, type LoadProgress } from './startLoadProgress.js';
import { startResolutionTrace, type ResolutionTrace } from './startResolutionTrace.js';
import type { SandboxLoadReport } from './watchSandboxLoad.js';

const bootReport = createReporter({ flow: 'boot' });
const resolveReport = createReporter({ flow: 'resolve' });
const contentReport = createReporter({ flow: 'content' });

/**
 * Count. The failure screen of a load whose product was already on screen threw. Tagged `outcome` (error) and
 * `reason` (the error's name).
 */
const resolveFailureScreenMetric = defineCount<'error'>('resolve.failure_screen');

/** Count. A transition of a load's reports threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const loadTelemetryTransitionMetric = defineCount<'error'>('load_telemetry.transition');

/** What happened to a load, for its reports. */
export type LoadEffect =
  | { kind: 'started'; label: string }
  | { kind: 'setUp' }
  | { kind: 'cacheChecked'; cid: string | null }
  | { kind: 'namePhase'; phase: ResolvePhase }
  | { kind: 'nameResolved'; cid: string | null }
  | { kind: 'manifestsRead'; manifests: ProductManifests }
  | { kind: 'rendering' }
  | { kind: 'handedOff' }
  | { kind: 'noContent' }
  | { kind: 'failed'; error: unknown; description: ErrorDescription }
  | { kind: 'screenFailed'; error: unknown; failure: string }
  | { kind: 'contentSettled'; report: SandboxLoadReport };

/** What the protocol frame reports about its light client, as far as a load reads it. */
type LoaderTelemetry = Pick<
  ProtocolClient['telemetry'],
  'subscribeChainSync' | 'subscribeChainDetail' | 'subscribeNetBytes' | 'getSmoldotDbOutcome'
>;

/** A load from the CID cache. */
type FastPath = { kind: 'fast' };

/** A load that missed the CID cache, so it goes through the name from `coldStart` on. */
type SlowPath = { kind: 'slow'; coldStart: number };

/** What a traced load holds. Its trace and its progress are collaborators with their own machines. */
type Traced = { label: string; chainTelemetry: LoaderTelemetry; trace: ResolutionTrace; progress: LoadProgress };

/**
 * Where a load's reports are. The attempt begins at the load's start, and the trace opens at its setup. From there on
 * each kind is named by the trace's step and owns what that step does, until a failure or a name with no content ends
 * the load.
 */
type TelemetryState =
  | { kind: 'waiting' }
  | { kind: 'begun'; label: string; attempt: Attempt }
  | { kind: 'cid_cache_read'; traced: Traced }
  | { kind: 'cached_launch_gate'; traced: Traced; path: FastPath }
  | {
      kind: 'name_resolve';
      traced: Traced;
      path: SlowPath;
      /** The debug panel's flow for the name's resolve. */
      resolveFlowId: string;
    }
  | { kind: 'manifest_read'; traced: Traced; path: SlowPath }
  | { kind: 'launch_gate'; traced: Traced; path: SlowPath }
  | {
      kind: 'render_handoff';
      traced: Traced;
      /** A load from the CID cache holds the fast path's end-to-end span, open until the handoff or the failure. */
      path: (FastPath & { span: SpanHandle }) | SlowPath;
    }
  | { kind: 'content'; traced: Traced; path: FastPath | SlowPath }
  | { kind: 'ended' };

type TelemetryMachine = MachineTypes<TelemetryState, LoadEffect>;

/** The kinds of a load whose trace is open. */
type TracedKind = Exclude<TelemetryState['kind'], 'waiting' | 'begun' | 'ended'>;

type TracedState = Extract<TelemetryState, { kind: TracedKind }>;

/** The runner of a load's reports, as its factory builds it. */
export type LoadTelemetry = ReturnType<typeof createLoadTelemetry>;

/** What a load's reports read. */
export type LoadTelemetryParams = {
  /** How the page reaches the chains, which decides how the content is checked. */
  backend: Backend;
  /** True when the settings skip the CID cache, so a load neither reads nor writes it. */
  skipCidCache: boolean;
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** `now` at page load. */
  startedAt: number;
  /** The content's blocks as they pass through this window. */
  blockRelay: Pick<SandboxBlockRelay, 'onProgress'>;
  /** The wall clock the debug events carry and the timers the load's deadlines run on. The page's by default. */
  timers?: Timers;
  /** The monotonic clock the load is measured on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
  /**
   * The protocol frame's reports on its light client. The page's protocol client's by default, read as a load
   * starts.
   */
  telemetry?: LoaderTelemetry;
  /** Where the load's debug events go. The page's bus by default. */
  debugBus?: DebugBus;
};

/** Builds the runner that makes one load's reports. Never throws. */
export function createLoadTelemetry({
  backend,
  skipCidCache,
  flowId,
  startedAt,
  blockRelay,
  timers = realTimers,
  now: readClock = readPageClock,
  telemetry,
  debugBus = pageDebugBus,
}: LoadTelemetryParams) {
  const lightClient = hasLightClient(backend);
  const resolveSource = lightClient ? 'smoldot' : 'rpc-gateway';
  const dependency = lightClient ? 'smoldot' : 'asset-hub-rpc';
  const cidCacheMiss = skipCidCache ? 'skipped' : 'miss';
  /** Reports the load's failure, ends a fast path's span with it, and finishes the trace. */
  const fail: HandlerOf<TelemetryMachine, TracedKind, 'failed'> = (state, { error, description }, { emitState }) => {
    emitState({ kind: 'ended' });
    const { label, chainTelemetry, trace } = state.traced;
    if (state.kind === 'render_handoff' && state.path.kind === 'fast') {
      state.path.span.setAttributes({ outcome: 'error' });
      state.path.span.end();
    }
    // A load on screen marked its main path's end as it was handed off.
    if (state.kind !== 'content') {
      performance.mark('dotli:main:end');
    }
    const cidCache = state.kind === 'cid_cache_read' ? 'unknown' : state.path.kind === 'fast' ? 'hit' : cidCacheMiss;
    // "n/a" where no light client gates the render, keeping "unknown" for a signal that should have arrived.
    const smoldotDbInapplicable = cidCache === 'hit' || !lightClient;
    const readSmoldotDb = (chain: Parameters<LoaderTelemetry['getSmoldotDbOutcome']>[0]) =>
      smoldotDbInapplicable ? 'n/a' : chainTelemetry.getSmoldotDbOutcome(chain);
    // Captured while the trace is still open, so the error lands in it.
    resolveReport.capture(error, {
      step: state.kind,
      span: trace.span,
      tags: {
        outcome: 'error',
        error_kind: description.kind,
        dependency,
        cid_cache: cidCache,
        smoldotdb_relay_cache: readSmoldotDb('relay'),
        smoldotdb_hub_cache: readSmoldotDb('assethub'),
        smoldotdb_bulletin_cache: readSmoldotDb('bulletin'),
        chain_backend: backend,
      },
    });
    trace.finish('error', { reason: getErrorMessage(error), errorKind: description.kind });
    log.debug(`[dot.li] Resolution failed via ${dependency}: ${serializeError(error)}`);
    debugBus.emit({
      layer: 'boot',
      event: 'failed',
      flowId,
      timestamp: timers.now(),
      payload: { label, reason: getErrorMessage(error), dependency },
    });
  };
  // Only a product in its frame has content outcomes to settle.
  const settleContent: HandlerOf<TelemetryMachine, 'render_handoff' | 'content', 'contentSettled'> = (
    { traced: { trace } },
    { report: { outcome, failedStep } },
  ) => {
    // The content fetch outlives the handoff, so each of its outcomes is heard, while the trace keeps the first.
    if (isLoadedOutcome(outcome)) {
      contentReport.log.event('Content loaded');
      endJourney();
      trace.finish('rendered');
      return;
    }
    contentReport.log.event('Content failed', { failed_step: failedStep ?? 'unknown' });
    trace.finish('content_error', failedStep !== undefined ? { failedStep } : {});
  };
  /** Opens the render's step, and the fast path's end-to-end span on a load from the CID cache. */
  const render: HandlerOf<TelemetryMachine, 'cached_launch_gate' | 'launch_gate', 'rendering'> = (
    { traced, path },
    _event,
    { emitState },
  ) => {
    enterStep(
      {
        kind: 'render_handoff',
        traced,
        path: path.kind === 'fast' ? { kind: 'fast', span: m.open('e2e.fast_path') } : path,
      },
      emitState,
    );
    traced.progress.enterContentFetch();
  };
  const machine = createStateMachine<TelemetryMachine>({
    initial: { kind: 'waiting' },
    handlers: {
      waiting: {
        started(_state, { label }, { emitState }) {
          const attempt = beginAttempt(label);
          emitState({ kind: 'begun', label, attempt });
          bootReport.log.event('Route: app', { label, attempt: attempt.attemptNumber, entry: attempt.entry });
          // On every event, so errors and the resolution span join into journeys without a second id.
          m.setDefaults({
            journey_id: attempt.journeyId,
            attempt_number: String(attempt.attemptNumber),
            entry: attempt.entry,
          });
        },
      },
      begun: {
        setUp({ label, attempt }, _event, { emitState }) {
          const chainTelemetry = telemetry ?? getProtocolClient().telemetry;
          const trace = startResolutionTrace({
            domain: withActiveTld(label),
            network: getNetwork(),
            backend,
            attempt,
            startedAt,
            timers,
            now: readClock,
          });
          // Kept past the load, as the chain reports go on feeding the network monitor, so the cleanup goes unused.
          const progress = startLoadProgress({
            label,
            backend,
            flowId,
            events: {
              onChainSync: chainTelemetry.subscribeChainSync,
              onChainDetail: chainTelemetry.subscribeChainDetail,
              onNetBytes: chainTelemetry.subscribeNetBytes,
              onContentProgress: blockRelay.onProgress,
            },
            trace,
            timers,
            now: readClock,
            debugBus,
          });
          enterStep({ kind: 'cid_cache_read', traced: { label, chainTelemetry, trace, progress } }, emitState);
        },
      },
      cid_cache_read: {
        cacheChecked({ traced }, { cid }, { emitState }) {
          const { label, trace } = traced;
          if (cid !== null) {
            enterStep({ kind: 'cached_launch_gate', traced, path: { kind: 'fast' } }, emitState);
            emitCacheChecked(label, cid);
            trace.recordCidCache('hit');
            cacheReadMetric.count({ outcome: 'hit', surface: 'cid_cache' });
            resolveReport.log.event('CID cache hit', { cid });
            trace.recordNameResolved(cid);
            return;
          }
          // Wall-clock, since a span detaches across the smoldot path's postMessage awaits.
          const coldStart = readClock();
          const resolveFlowId = createRandomId();
          enterStep({ kind: 'name_resolve', traced, path: { kind: 'slow', coldStart }, resolveFlowId }, emitState);
          emitCacheChecked(label, null);
          trace.recordCidCache(cidCacheMiss);
          if (skipCidCache) {
            resolveReport.log.event('CID cache skipped by settings');
          } else {
            cacheReadMetric.count({ outcome: 'miss', surface: 'cid_cache' });
            resolveReport.log.event('CID cache miss');
          }
          performance.mark('dotli:resolve:start');
          debugBus.emit({
            layer: 'resolve',
            event: 'started',
            flowId: resolveFlowId,
            timestamp: timers.now(),
            payload: { label, source: resolveSource },
          });
          resolveReport.log.event('Resolving name', { name: withActiveTld(`app.${label}`), backend });
        },
        failed: fail,
      },
      cached_launch_gate: { rendering: render, failed: fail },
      name_resolve: {
        namePhase({ traced: { label, progress }, resolveFlowId }, { phase }) {
          progress.resolvePhase(phase);
          debugBus.emit({
            layer: 'resolve',
            event: 'phase',
            flowId: resolveFlowId,
            timestamp: timers.now(),
            payload: { label, phase },
          });
        },
        nameResolved({ traced, path, resolveFlowId }, { cid }, { emitState }) {
          const { label, trace, progress } = traced;
          const { coldStart } = path;
          if (cid !== null) {
            enterStep({ kind: 'manifest_read', traced, path }, emitState);
          }
          const now = readClock();
          debugBus.emit({
            layer: 'resolve',
            event: 'completed',
            flowId: resolveFlowId,
            timestamp: timers.now(),
            payload: { label, source: resolveSource, cid, durationMs: now - coldStart },
          });
          progress.markNameResolved();
          performance.mark('dotli:resolve:end');
          log.debug(
            `[dot.li resolve] RESOLVED ${withActiveTld(label)} via ${backend} in ${formatDuration(coldStart, { now })} (total ${formatElapsed(startedAt, { now })}) -> ${cid ?? 'null'}`,
          );
          resolveReport.log.event(cid === null ? 'Name has no contenthash' : 'Name resolved', {
            ms: Math.round(now - coldStart),
            ...(cid !== null ? { cid } : {}),
          });
          trace.recordNameResolved(cid);
        },
        noContent({ traced }, _event, { emitState }) {
          emitState({ kind: 'ended' });
          endJourney();
          traced.trace.finish('no_content');
          performance.mark('dotli:main:end');
        },
        failed: fail,
      },
      manifest_read: {
        manifestsRead({ traced, path }, { manifests }, { emitState }) {
          enterStep({ kind: 'launch_gate', traced, path }, emitState);
          resolveReport.log.event('Manifests read', { root: manifests.root.kind, app: manifests.app.kind });
        },
        failed: fail,
      },
      launch_gate: { rendering: render, failed: fail },
      render_handoff: {
        handedOff({ traced, path }, _event, { emitState }) {
          const { label, trace } = traced;
          enterStep({ kind: 'content', traced, path: path.kind === 'fast' ? { kind: 'fast' } : path }, emitState);
          const now = readClock();
          switch (path.kind) {
            case 'fast':
              path.span.end();
              break;
            case 'slow':
              m.distribution('e2e.slow_path', now - path.coldStart, {
                unit: 'millisecond',
                attributes: { outcome: 'ok', chain_backend: backend },
              });
              break;
          }
          const totalMs = now - startedAt;
          performance.mark('dotli:main:end');
          resolveReport.log.event('Sandbox mounted', {
            path: path.kind === 'fast' ? 'cache' : 'cold',
            total_ms: Math.round(totalMs),
          });
          trace.markHandedOff();
          debugBus.emit({
            layer: 'boot',
            event: 'ready',
            flowId,
            timestamp: timers.now(),
            payload: { label, totalMs, path: path.kind },
          });
        },
        failed: fail,
        contentSettled: settleContent,
      },
      content: { failed: fail, contentSettled: settleContent },
      ended: {
        screenFailed(_state, { error, failure }) {
          resolveReport.defect(error, {
            step: 'failure_screen',
            metric: resolveFailureScreenMetric,
            message: `[dot.li] The failure screen for ${failure} failed:`,
          });
        },
      },
    },
    onError: error => {
      resolveReport.defect(error, {
        step: 'transition',
        metric: loadTelemetryTransitionMetric,
        message: '[dot.li] A load telemetry transition threw',
      });
    },
  });

  return {
    /**
     * Makes the reports of `effect`. An effect out of order is ignored. Never throws, and a throw of a report is
     * reported.
     */
    report: (effect: LoadEffect): void => {
      machine.update(effect);
    },
  };

  function emitCacheChecked(label: string, cid: string | null): void {
    debugBus.emit({
      layer: 'boot',
      event: 'cid_cache_checked',
      flowId,
      timestamp: timers.now(),
      payload: { label, hit: cid !== null, ...(cid !== null ? { cid } : {}) },
    });
  }
}

/** Moves a traced load to the step `next` names, and records that step on its trace. */
function enterStep(next: TracedState, emitState: Transition<TelemetryMachine>['emitState']): void {
  emitState(next);
  next.traced.trace.recordStep(next.kind);
}
