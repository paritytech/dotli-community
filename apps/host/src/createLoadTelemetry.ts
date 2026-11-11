// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns what happened to a product load into its reports, in the order the load tells it.

import type { SandboxBlockRelay } from '@dotli/bitswap';
import { getNetwork, hasLightClient, withActiveTld, type Backend } from '@dotli/config';
import { createReporter, defineCount, m } from '@dotli/metrics';
import { getProtocolClient, type ProtocolClient } from '@dotli/protocol';
import type { ResolvePhase } from '@dotli/resolver';
import { isLoadedOutcome } from '@dotli/sandbox-wire';
import {
  createRandomId,
  formatDuration,
  formatElapsed,
  getErrorMessage,
  log,
  realTimers,
  serializeError,
  type Timers,
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

/** What happened to a load, for its reports. */
export type LoadEffect =
  | { kind: 'started'; label: string }
  | { kind: 'setUp' }
  | { kind: 'cacheChecked'; cid: string | null }
  | { kind: 'resolvingName' }
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

/** A load that missed the CID cache, so it goes through the name from `coldStart` on. */
type SlowPath = { kind: 'slow'; coldStart: number };

/** Where a traced load is, named by the trace's steps, and what each step owns. */
type Phase =
  | { kind: 'cid_cache_read' }
  | { kind: 'cached_launch_gate'; path: { kind: 'fast' } }
  | {
      kind: 'name_resolve';
      path: SlowPath;
      /** The debug panel's flow for the name's resolve. */
      flowId: string;
    }
  | { kind: 'manifest_read'; path: SlowPath }
  | { kind: 'launch_gate'; path: SlowPath }
  | { kind: 'render_handoff'; path: { kind: 'fast' } | SlowPath }
  | { kind: 'content'; path: { kind: 'fast' } | SlowPath };

/** A load whose trace is open. */
type Tracing = {
  kind: 'tracing';
  label: string;
  chainTelemetry: LoaderTelemetry;
  trace: ResolutionTrace;
  progress: LoadProgress;
  phase: Phase;
};

/** A load whose attempt has begun and whose trace is not open yet. */
type Begun = { kind: 'begun'; label: string; attempt: Attempt };

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
  const resolveSource = hasLightClient(backend) ? 'smoldot' : 'rpc-gateway';
  const cidCacheMiss = skipCidCache ? 'skipped' : 'miss';
  let state: { kind: 'waiting' } | Begun | Tracing = { kind: 'waiting' };

  return {
    /**
     * Makes the reports of `effect`. Throws for an effect out of order: anything but `started` first, anything but
     * `setUp` second, either of them later, or one that reads a step the load is not at. Throws as a report throws.
     */
    report,
  };

  function report(effect: LoadEffect): void {
    switch (state.kind) {
      case 'waiting':
        if (effect.kind === 'started') {
          begin(effect.label);
          return;
        }
        break;
      case 'begun':
        if (effect.kind === 'setUp') {
          setUp(state);
          return;
        }
        break;
      case 'tracing':
        if (effect.kind !== 'started' && effect.kind !== 'setUp') {
          reportTraced(state, effect);
          return;
        }
        break;
    }
    throw new Error(`Load effect '${effect.kind}' came out of order, while the load was ${state.kind}`);
  }

  function begin(label: string): void {
    const attempt = beginAttempt(label);
    state = { kind: 'begun', label, attempt };
    bootReport.log.event('Route: app', { label, attempt: attempt.attemptNumber, entry: attempt.entry });
    // On every event, so errors and the resolution span join into journeys without a second id.
    m.setDefaults({
      journey_id: attempt.journeyId,
      attempt_number: String(attempt.attemptNumber),
      entry: attempt.entry,
    });
  }

  function setUp({ label, attempt }: Begun): void {
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
    state = { kind: 'tracing', label, chainTelemetry, trace, progress, phase: { kind: 'cid_cache_read' } };
    trace.recordStep('cid_cache_read');
  }

  function reportTraced(tracing: Tracing, effect: Exclude<LoadEffect, { kind: 'started' | 'setUp' }>): void {
    const { label, trace, phase } = tracing;
    switch (effect.kind) {
      case 'cacheChecked': {
        const { cid } = effect;
        if (cid !== null) {
          enterPhase(tracing, { kind: 'cached_launch_gate', path: { kind: 'fast' } });
        }
        debugBus.emit({
          layer: 'boot',
          event: 'cid_cache_checked',
          flowId,
          timestamp: timers.now(),
          payload: { label, hit: cid !== null, ...(cid !== null ? { cid } : {}) },
        });
        trace.recordCidCache(cid !== null ? 'hit' : cidCacheMiss);
        if (cid !== null) {
          cacheReadMetric.count({ outcome: 'hit', surface: 'cid_cache' });
          resolveReport.log.event('CID cache hit', { cid });
          trace.recordNameResolved(cid);
          return;
        }
        if (skipCidCache) {
          resolveReport.log.event('CID cache skipped by settings');
          return;
        }
        cacheReadMetric.count({ outcome: 'miss', surface: 'cid_cache' });
        resolveReport.log.event('CID cache miss');
        return;
      }
      case 'resolvingName': {
        // Wall-clock, since a span detaches across the smoldot path's postMessage awaits.
        const coldStart = readClock();
        const resolveFlowId = createRandomId();
        enterPhase(tracing, { kind: 'name_resolve', path: { kind: 'slow', coldStart }, flowId: resolveFlowId });
        performance.mark('dotli:resolve:start');
        debugBus.emit({
          layer: 'resolve',
          event: 'started',
          flowId: resolveFlowId,
          timestamp: timers.now(),
          payload: { label, source: resolveSource },
        });
        resolveReport.log.event('Resolving name', { name: withActiveTld(`app.${label}`), backend });
        return;
      }
      case 'namePhase':
        if (phase.kind !== 'name_resolve') {
          break;
        }
        tracing.progress.resolvePhase(effect.phase);
        debugBus.emit({
          layer: 'resolve',
          event: 'phase',
          flowId: phase.flowId,
          timestamp: timers.now(),
          payload: { label, phase: effect.phase },
        });
        return;
      case 'nameResolved': {
        if (phase.kind !== 'name_resolve') {
          break;
        }
        const { cid } = effect;
        const { coldStart } = phase.path;
        if (cid !== null) {
          enterPhase(tracing, { kind: 'manifest_read', path: phase.path });
        }
        debugBus.emit({
          layer: 'resolve',
          event: 'completed',
          flowId: phase.flowId,
          timestamp: timers.now(),
          payload: { label, source: resolveSource, cid, durationMs: readClock() - coldStart },
        });
        tracing.progress.markNameResolved();
        performance.mark('dotli:resolve:end');
        log.debug(
          `[dot.li resolve] RESOLVED ${withActiveTld(label)} via ${backend} in ${formatDuration(coldStart, { now: readClock() })} (total ${formatElapsed(startedAt, { now: readClock() })}) -> ${cid ?? 'null'}`,
        );
        resolveReport.log.event(cid === null ? 'Name has no contenthash' : 'Name resolved', {
          ms: Math.round(readClock() - coldStart),
          ...(cid !== null ? { cid } : {}),
        });
        trace.recordNameResolved(cid);
        return;
      }
      case 'manifestsRead':
        if (phase.kind !== 'manifest_read') {
          break;
        }
        enterPhase(tracing, { kind: 'launch_gate', path: phase.path });
        resolveReport.log.event('Manifests read', { root: effect.manifests.root.kind, app: effect.manifests.app.kind });
        return;
      case 'rendering':
        if (phase.kind !== 'cached_launch_gate' && phase.kind !== 'launch_gate') {
          break;
        }
        enterPhase(tracing, { kind: 'render_handoff', path: phase.path });
        tracing.progress.enterContentFetch();
        return;
      case 'handedOff':
        if (phase.kind !== 'render_handoff') {
          break;
        }
        enterPhase(tracing, { kind: 'content', path: phase.path });
        switch (phase.path.kind) {
          case 'fast':
            performance.mark('dotli:main:end');
            resolveReport.log.event('Sandbox mounted', {
              path: 'cache',
              total_ms: Math.round(readClock() - startedAt),
            });
            debugBus.emit({
              layer: 'boot',
              event: 'ready',
              flowId,
              timestamp: timers.now(),
              payload: { label, totalMs: readClock() - startedAt, path: 'fast' },
            });
            trace.markHandedOff();
            break;
          case 'slow':
            m.distribution('e2e.slow_path', readClock() - phase.path.coldStart, {
              unit: 'millisecond',
              attributes: { outcome: 'ok', chain_backend: backend },
            });
            performance.mark('dotli:main:end');
            resolveReport.log.event('Sandbox mounted', {
              path: 'cold',
              total_ms: Math.round(readClock() - startedAt),
            });
            trace.markHandedOff();
            debugBus.emit({
              layer: 'boot',
              event: 'ready',
              flowId,
              timestamp: timers.now(),
              payload: { label, totalMs: readClock() - startedAt, path: 'slow' },
            });
            break;
        }
        return;
      case 'noContent':
        endJourney();
        trace.finish('no_content');
        performance.mark('dotli:main:end');
        return;
      case 'failed': {
        const { chainTelemetry } = tracing;
        const { error, description } = effect;
        // A load on screen marked its main path's end as it was handed off.
        if (phase.kind !== 'content') {
          performance.mark('dotli:main:end');
        }
        const dependency = hasLightClient(backend) ? 'smoldot' : 'asset-hub-rpc';
        const cidCache = getCidCacheResult(phase, cidCacheMiss);
        // "n/a" where no light client gates the render, keeping "unknown" for a signal that should have arrived.
        const smoldotDbInapplicable = cidCache === 'hit' || !hasLightClient(backend);
        // Captured while the trace is still open, so the error lands in it.
        resolveReport.capture(error, {
          step: phase.kind,
          span: trace.span,
          tags: {
            outcome: 'error',
            error_kind: description.kind,
            dependency,
            cid_cache: cidCache,
            smoldotdb_relay_cache: smoldotDbInapplicable ? 'n/a' : chainTelemetry.getSmoldotDbOutcome('relay'),
            smoldotdb_hub_cache: smoldotDbInapplicable ? 'n/a' : chainTelemetry.getSmoldotDbOutcome('assethub'),
            smoldotdb_bulletin_cache: smoldotDbInapplicable ? 'n/a' : chainTelemetry.getSmoldotDbOutcome('bulletin'),
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
        return;
      }
      case 'screenFailed':
        resolveReport.defect(effect.error, {
          step: 'failure_screen',
          metric: resolveFailureScreenMetric,
          message: `[dot.li] The failure screen for ${effect.failure} failed:`,
        });
        return;
      case 'contentSettled': {
        const { outcome, failedStep } = effect.report;
        // The content fetch outlives the handoff, so each of its outcomes is heard, while the trace keeps the first.
        if (isLoadedOutcome(outcome)) {
          contentReport.log.event('Content loaded');
          endJourney();
          trace.finish('rendered');
          return;
        }
        contentReport.log.event('Content failed', { failed_step: failedStep ?? 'unknown' });
        trace.finish('content_error', failedStep !== undefined ? { failedStep } : {});
        return;
      }
    }
    throw new Error(`Load effect '${effect.kind}' came out of order, while the load was at ${phase.kind}`);
  }

  function enterPhase(tracing: Tracing, phase: Phase): void {
    state = { ...tracing, phase };
    tracing.trace.recordStep(phase.kind);
  }
}

/** Reads what a load at `phase` found in the CID cache, where a miss reads as `miss`. */
function getCidCacheResult(phase: Phase, miss: 'miss' | 'skipped') {
  switch (phase.kind) {
    case 'cid_cache_read':
      return 'unknown';
    case 'cached_launch_gate':
      return 'hit';
    case 'name_resolve':
    case 'manifest_read':
    case 'launch_gate':
      return miss;
    case 'render_handoff':
    case 'content':
      switch (phase.path.kind) {
        case 'fast':
          return 'hit';
        case 'slow':
          return miss;
      }
  }
}
