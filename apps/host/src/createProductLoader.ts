// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes a `.dot` label to a product on screen, or to the screen that says why not: the CID cache or the name, the
// manifests' verdict, the render and the content's outcome. What sits in another frame or origin (the name source, the
// product frame, the recent list, the protocol frame's telemetry, the block client) and what reloads or writes the page
// (the CID cache, the failure screen) is passed in. The page's own state is imported.

import {
  getActiveTldSuffix,
  getNetwork,
  hasLightClient,
  isVerifiedSession,
  withActiveTld,
  type Backend,
} from '@dotli/config';
import type { SandboxBlockRelay } from '@dotli/bitswap';
import { createReporter, defineCount, m } from '@dotli/metrics';
import { getProtocolClient, type ProtocolClient, type ProtocolVersionMismatchError } from '@dotli/protocol';
import { isLoadedOutcome } from '@dotli/sandbox-wire';
import {
  createAsyncTaskPool,
  formatDuration,
  formatElapsed,
  getErrorMessage,
  log,
  markHandled,
  noop,
  createRandomId,
  realTimers,
  serializeError,
  type Timers,
} from '@dotli/shared';
import type { CachedManifests } from '@dotli/storage';
import { debugBus as pageDebugBus, type DebugBus } from '@dotli/truapi-debug';
import { readChatCapability } from './readChatCapability.js';
import { describeError } from './describeError.js';
import { beginAttempt, endJourney } from './journey.js';
import type { LoadFailure } from './presentLoadFailure.js';
import { startLoadProgress, type LoadEvents } from './startLoadProgress.js';
import { assertLaunchable } from './assertLaunchable.js';
import { fromCachedManifest, toCachedManifest, type ProductManifests } from './cachedManifest.js';
import { getProductFacts } from './getProductFacts.js';
import type { NameSource } from './createNameSource.js';
import { showNoContentError } from './showNoContentError.js';
import type { SandboxLoad } from './watchSandboxLoad.js';
import { applyProductBranding } from './applyProductBranding.js';
import type { RecentLabels } from './createRecentLabels.js';
import { startResolutionTrace, type CidCacheResult } from './startResolutionTrace.js';
import type { HostBridge } from './runtime/bridge.js';
import type { CoreLease } from './runtime/createPageCore.js';
import type { ProductFrame } from './runtime/createProductFrame.js';
import { authState } from './runtime/state/authState.js';
import { productState } from './runtime/state/productState.js';
import { startShieldAutoHide } from './startShieldAutoHide.js';
import { urlPillState, type ShieldState } from './state/urlPillState.js';
import { pageTopbarAutoHide } from './createTopbarAutoHide.js';
import { readPageClock } from './readPageClock.js';
import { cacheReadMetric } from './cacheReadMetric.js';

const bootReport = createReporter({ flow: 'boot' });
const resolveReport = createReporter({ flow: 'resolve' });
const contentReport = createReporter({ flow: 'content' });

/**
 * Count. The failure screen of a load whose product was already on screen threw. Tagged `outcome` (error) and
 * `reason` (the error's name).
 */
const resolveFailureScreenMetric = defineCount<'error'>('resolve.failure_screen');

/** From CID cache hit to content rendered. */
const E2E_FAST = 'e2e.fast_path';

/** CID cache miss, then resolve, fetch and render. */
const E2E_SLOW = 'e2e.slow_path';

/** Where a load is: reading, handed to the frame with its two listeners held, or failed with its screen shown. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'handedOff'; stopHearingMismatch: () => void; stopFollowingContent: () => void }
  | { kind: 'failed' };

/** What the loader reaches outside itself, one member per owner. */
export type LoaderPorts = {
  /** The page's product frame. */
  product: Pick<ProductFrame, 'render' | 'halt'>;
  /** The bridge's page core, named and leased as the load starts. */
  core: {
    /**
     * Names the product before anything resolves, so a login clicked meanwhile boots its core rather than a second
     * one. Throws when the page's core is not set up yet.
     */
    setPageProduct: HostBridge['setPageProduct'];
    /**
     * Leases the page product's core, so it boots while the load reads the name. Rejects when the core cannot boot,
     * with the boot's error or `CoreRedialError` for a replacement that could not boot. Throws when the page's core
     * is not set up yet.
     */
    acquirePageCore: () => Promise<Pick<CoreLease, 'release'>>;
  };
  /** What the sandbox reported about its load. */
  sandbox: Pick<SandboxLoad, 'subscribeOutcomes' | 'expectHeardWithin'>;
  /** The content's blocks as they pass through this window. */
  content: Pick<SandboxBlockRelay, 'onProgress'>;
};

/** A label's content as the CID cache keeps it. */
export type CachedCopy = {
  label: string;
  cid: string;
  manifests: CachedManifests;
};

/** A label's content as the CID cache serves it. */
type CachedEntry = Omit<CachedCopy, 'label'>;

/** A copy the CID cache served. */
export type ServedCopy = {
  label: string;
  /** The CID of the copy the page was served. */
  servedCid: string;
  /** False when the copy was refused rather than rendered, so the page shows no product to reload. */
  onScreen: boolean;
};

/** The CID cache for this network. Writes and checks wait for the page to be idle, so they never hold a render back. */
export type LoaderCidCache = {
  /** Resolves the label's content, or null when none is kept. Rejects when the read fails. */
  get: (label: string) => Promise<CachedEntry | null>;
  /** Keeps the label's content for the next load. Never throws. */
  storeLater: (copy: CachedCopy) => void;
  /** Checks a served copy against the network. Never throws. */
  revalidateLater: (copy: ServedCopy) => void;
};

/** The failure's screen, and the sighting that lets a failure a reload did not fix offer more. */
export type LoaderFailureScreen = {
  /** Shows the screen for `failure`. Throws when the screen cannot be shown. */
  show: (failure: LoadFailure) => void;
  /** Records that the previous attempt's failure is behind the visitor. Never throws. */
  forget: () => void;
};

/** What the protocol frame reports about its light client, as far as a load reads it. */
type LoaderTelemetry = Pick<
  ProtocolClient['telemetry'],
  'subscribeChainSync' | 'subscribeChainDetail' | 'subscribeNetBytes' | 'getSmoldotDbOutcome'
>;

type Params = {
  /** How the page reaches the chains, which decides how the content is checked. */
  backend: Backend;
  /** True when the settings skip the CID cache, so a load neither reads nor writes it. */
  skipCidCache: boolean;
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** `now` at page load. */
  startedAt: number;
  /** Where names and manifests are read. */
  names: NameSource;
  /** What the load reaches outside itself. */
  ports: LoaderPorts;
  /** The page path ahead of the product's own, which its frame does not get. */
  base?: string | undefined;
  /** The CID cache for this network. */
  cidCache: LoaderCidCache;
  /** The names this visitor opened, kept in the store every subdomain shares. */
  recents: Pick<RecentLabels, 'record'>;
  /** The screen a failed load shows. */
  failureScreen: LoaderFailureScreen;
  /**
   * Hears once that a protocol frame refused this page's wire version, at once if one already did. Returns its
   * unsubscribe.
   */
  onProtocolVersionMismatch: (listener: (error: ProtocolVersionMismatchError) => void) => () => void;
  /** The wall clock the debug events carry and the timers the load's deadlines run on. The page's by default. */
  timers?: Timers;
  /** The monotonic clock the load is measured on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
  /**
   * Reads one block of the product's content for its icon, abandoned when the signal aborts. Rejects when the read
   * fails.
   */
  fetchBlock: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** The protocol frame's reports on its light client. The page's protocol client's by default, read as a load starts. */
  telemetry?: LoaderTelemetry;
  /** Where the load's debug events go. The page's bus by default. */
  debugBus?: DebugBus;
};

/** Builds the page's loader. Never throws. */
export function createProductLoader({ ...options }: Params) {
  const loads = createAsyncTaskPool({ poolSize: 1 });
  const loaded = new Set<string>();
  return {
    /**
     * Loads the page's product. Repeating it for the same label waits for that load and does nothing more. A failed
     * load shows its screen, and rejects with what that screen threw.
     */
    load: (label: string): Promise<void> =>
      loads.call(async () => {
        if (loaded.has(label)) {
          return;
        }
        loaded.add(label);
        await loadProduct(label, options);
      }),
  };
}

async function loadProduct(label: string, options: Params): Promise<void> {
  // The defaults sit here rather than in the factory, which hands its params on whole.
  const {
    backend,
    names,
    ports,
    cidCache,
    flowId,
    startedAt,
    timers = realTimers,
    now: readClock = readPageClock,
    fetchBlock,
    telemetry = getProtocolClient().telemetry,
    debugBus = pageDebugBus,
  } = options;
  const attempt = beginAttempt(label);
  bootReport.log.event('Route: app', { label, attempt: attempt.attemptNumber, entry: attempt.entry });
  // On every event, so errors and the resolution span join into journeys without a second id.
  m.setDefaults({
    journey_id: attempt.journeyId,
    attempt_number: String(attempt.attemptNumber),
    entry: attempt.entry,
  });
  ports.core.setPageProduct({ label });

  // In parallel with the CID. The frame awaits it before it connects the product, whose execution kind it picks.
  const chat = readChatCapability(label, async () => {
    const result = await names.readWorkerManifest(label);
    return result.kind === 'ok' && result.value.kind === 'worker' && result.value.includes.chat === true;
  });

  urlPillState.showProduct(label, getActiveTldSuffix());

  // The shield shows how the content was checked, and the topbar may fold from then on.
  const shieldState: ShieldState = isVerifiedSession(backend) ? 'verified' : 'trusted';
  // A page loads one product, so the bar folds for the page's life and the cleanup goes unused.
  const autoHide = startShieldAutoHide({ loggedIn: authState.loggedInStore, arm: pageTopbarAutoHide.arm });
  function settleShield(): void {
    urlPillState.setVerificationShield(shieldState);
    autoHide.settle();
  }

  const trace = startResolutionTrace({
    domain: withActiveTld(label),
    network: getNetwork(),
    backend,
    attempt,
    startedAt,
    timers,
    now: readClock,
  });
  // For the trace's `loading_phase` and the capture below.
  let step = 'resolve_setup';
  function enterStep(next: string): void {
    step = next;
    trace.recordStep(next);
  }
  const events: LoadEvents = {
    onChainSync: telemetry.subscribeChainSync,
    onChainDetail: telemetry.subscribeChainDetail,
    onNetBytes: telemetry.subscribeNetBytes,
    onContentProgress: ports.content.onProgress,
  };
  // Kept past the load, as the chain reports go on feeding the network monitor, so the cleanup goes unused.
  const progress = startLoadProgress({ label, backend, flowId, events, trace, timers, now: readClock, debugBus });

  // Read in the catch below, so a warm-path failure is not counted against the cold path.
  let cidCacheResult: CidCacheResult | 'unknown' = 'unknown';

  // "n/a" where no light client gates the render, keeping "unknown" for a signal that should have arrived.
  function getSmoldotDbCacheTags(): Record<string, string> {
    const inapplicable = cidCacheResult === 'hit' || !hasLightClient(backend);
    return {
      smoldotdb_relay_cache: inapplicable ? 'n/a' : telemetry.getSmoldotDbOutcome('relay'),
      smoldotdb_hub_cache: inapplicable ? 'n/a' : telemetry.getSmoldotDbOutcome('assethub'),
      smoldotdb_bulletin_cache: inapplicable ? 'n/a' : telemetry.getSmoldotDbOutcome('bulletin'),
    };
  }

  let state: LoadState = { kind: 'loading' };
  /** Reads the state through a call, so a check after a callback that may have failed the load is not narrowed away. */
  function hasFailed(): boolean {
    return state.kind === 'failed';
  }
  /** Reports the failure and shows its screen. Throws what the screen threw. */
  function failLoad(error: unknown): void {
    const previous = state;
    state = { kind: 'failed' };
    if (previous.kind === 'handedOff') {
      previous.stopHearingMismatch();
      previous.stopFollowingContent();
    }
    // One verdict drives both the report and the error page, so `error_kind` counts exactly the screens shown.
    const description = describeError(error, { readBackend: () => backend });
    // Reported before rendering, in case rendering throws, and while the trace is still open, so the error lands in it.
    const dependency = hasLightClient(backend) ? 'smoldot' : 'asset-hub-rpc';
    resolveReport.capture(error, {
      step,
      span: trace.span,
      tags: {
        outcome: 'error',
        error_kind: description.kind,
        dependency,
        cid_cache: cidCacheResult,
        ...getSmoldotDbCacheTags(),
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
    // Once for the failed load, however many times the user moves between its error screens.
    productState.setError();
    options.failureScreen.show({ error: description, cause: error, label, backend });
  }
  /**
   * Ends a load whose product is already on screen, which only a reload can bring back, so the frame stops showing it
   * again. A screen that fails is reported here, since nothing waits on the load anymore.
   */
  function failAfterHandoff(error: unknown, failure: string): void {
    if (hasFailed()) {
      return;
    }
    ports.product.halt();
    try {
      failLoad(error);
    } catch (screenError: unknown) {
      resolveReport.defect(screenError, {
        step: 'failure_screen',
        metric: resolveFailureScreenMetric,
        message: `[dot.li] The failure screen for ${failure} failed:`,
      });
    }
  }
  // The content fetch outlives the handoff, so the load follows each attempt's outcome while the trace keeps the first.
  function settleOnContent(): () => void {
    return ports.sandbox.subscribeOutcomes(({ outcome, failedStep }) => {
      if (hasFailed()) {
        return;
      }
      const loaded = isLoadedOutcome(outcome);
      pageTopbarAutoHide.setContentShown(loaded);
      if (loaded) {
        contentReport.log.event('Content loaded');
        endJourney();
        trace.finish('rendered');
        return;
      }
      contentReport.log.event('Content failed', { failed_step: failedStep ?? 'unknown' });
      trace.finish('content_error', failedStep !== undefined ? { failedStep } : {});
    });
  }
  /** Resolves false when a failure heard during the render already ended the load, so nothing after it runs. */
  async function render(cid: string, manifests: ProductManifests): Promise<boolean> {
    progress.enterContentFetch();
    enterStep('render_handoff');
    await coreHold;
    try {
      await ports.product.render({
        mode: 'subdomain',
        label,
        cid,
        base: options.base,
        chat,
        facts: getProductFacts(manifests),
      });
    } catch (error) {
      // A render that failed after it mounted the product leaves it holding its core under the failure screen.
      ports.product.halt();
      throw error;
    }
    // A protocol frame rebuilt while the app is open can come from a newer release. It refuses this page for good, and
    // the app would sit there with no chain or store, so the reload screen replaces it.
    const stopHearingMismatch = options.onProtocolVersionMismatch(error => {
      failAfterHandoff(error, 'a protocol version mismatch');
    });
    if (hasFailed()) {
      stopHearingMismatch();
      return false;
    }
    // From the handoff, since the render before it can wait on the shared store for as long as the protocol frame is down.
    void ports.sandbox.expectHeardWithin().catch((error: unknown) => {
      failAfterHandoff(error, 'a silent sandbox');
    });
    const stopFollowingContent = settleOnContent();
    state = { kind: 'handedOff', stopHearingMismatch, stopFollowingContent };
    return true;
  }
  function settleRendered(manifests: ProductManifests): void {
    options.failureScreen.forget();
    void options.recents.record(label);
    void applyProductBranding({ label, manifests, fetchBlock, timers });
  }
  function markHandedOff(): void {
    trace.markHandedOff();
    enterStep('content');
  }
  function emitReady(path: 'fast' | 'slow'): void {
    debugBus.emit({
      layer: 'boot',
      event: 'ready',
      flowId,
      timestamp: timers.now(),
      payload: { label, totalMs: readClock() - startedAt, path },
    });
  }

  /** Resolves the label's copy in the CID cache, or null when it holds none or the settings skip it. */
  async function readCachedCopy(): Promise<CachedEntry | null> {
    enterStep('cid_cache_read');
    const cached = options.skipCidCache ? null : await cidCache.get(label);
    const cachedCid = cached?.cid ?? null;
    debugBus.emit({
      layer: 'boot',
      event: 'cid_cache_checked',
      flowId,
      timestamp: timers.now(),
      payload: { label, hit: cachedCid !== null, ...(cachedCid !== null ? { cid: cachedCid } : {}) },
    });
    cidCacheResult = getCidCacheResult(cachedCid, options.skipCidCache);
    trace.recordCidCache(cidCacheResult);
    return cached;
  }
  /** Launches the copy the CID cache served, then has it checked against the network. Rejects when it is refused. */
  async function loadCached(cached: CachedEntry): Promise<void> {
    cacheReadMetric.count({ outcome: 'hit', surface: 'cid_cache' });
    resolveReport.log.event('CID cache hit', { cid: cached.cid });
    trace.recordNameResolved(cached.cid);
    // A copy that no longer passes is refused but kept: only a cleanup or a redeploy drops cached manifests.
    const cachedManifests = fromCachedManifest(cached.manifests);
    enterStep('cached_launch_gate');
    try {
      assertLaunchable(cachedManifests.root, cachedManifests.app);
    } catch (error) {
      cidCache.revalidateLater({ label, servedCid: cached.cid, onScreen: false });
      throw error;
    }
    const live = await m.span(E2E_FAST, () => {
      settleShield();
      return render(cached.cid, cachedManifests);
    });
    if (!live) {
      return;
    }
    settleRendered(cachedManifests);
    performance.mark('dotli:main:end');
    resolveReport.log.event('Sandbox mounted', {
      path: 'cache',
      total_ms: Math.round(readClock() - startedAt),
    });
    emitReady('fast');
    markHandedOff();
    // Keeps the cache honest without blocking the render.
    cidCache.revalidateLater({ label, servedCid: cached.cid, onScreen: true });
  }
  /**
   * Resolves the name and reads its manifests, then launches what they name, or shows that nothing is published.
   * Rejects when a read fails or the product is refused.
   */
  async function loadCold(): Promise<void> {
    if (cidCacheResult === 'miss') {
      cacheReadMetric.count({ outcome: 'miss', surface: 'cid_cache' });
    }
    resolveReport.log.event(cidCacheResult === 'skipped' ? 'CID cache skipped by settings' : 'CID cache miss');

    // Wall-clock, since a span detaches across the smoldot path's postMessage awaits.
    const coldStartMs = readClock();
    performance.mark('dotli:resolve:start');
    // In parallel with the CID, and awaited before anything renders, so a refused product is never downloaded. A CID
    // failure first leaves its failure to the load's outcome.
    const manifestsRead = markHandled(names.readManifests(label));
    const cid = await resolveName();

    // Nothing to launch whatever the manifests say, so it does not wait on them.
    if (cid === null) {
      // Its recent pill stays: the name may still resolve on another network.
      showNoContentError(label);
      productState.setError();
      endJourney();
      trace.finish('no_content');
      performance.mark('dotli:main:end');
      return;
    }

    enterStep('manifest_read');
    const manifests = await manifestsRead;
    resolveReport.log.event('Manifests read', { root: manifests.root.kind, app: manifests.app.kind });
    enterStep('launch_gate');
    assertLaunchable(manifests.root, manifests.app);

    if (!options.skipCidCache) {
      cidCache.storeLater({ label, cid, manifests: toCachedManifest(manifests) });
    }

    settleShield();
    if (!(await render(cid, manifests))) {
      return;
    }
    settleRendered(manifests);

    m.distribution(E2E_SLOW, readClock() - coldStartMs, {
      unit: 'millisecond',
      attributes: { outcome: 'ok', chain_backend: backend },
    });
    performance.mark('dotli:main:end');
    resolveReport.log.event('Sandbox mounted', {
      path: 'cold',
      total_ms: Math.round(readClock() - startedAt),
    });
    markHandedOff();
    emitReady('slow');
  }
  /** Resolves the name's CID, or null when it has none. Rejects as the name source does. */
  async function resolveName(): Promise<string | null> {
    enterStep('name_resolve');
    const resolveStart = readClock();

    const resolveFlowId = createRandomId();
    const resolveSource: 'smoldot' | 'rpc-gateway' = hasLightClient(backend) ? 'smoldot' : 'rpc-gateway';
    debugBus.emit({
      layer: 'resolve',
      event: 'started',
      flowId: resolveFlowId,
      timestamp: timers.now(),
      payload: { label, source: resolveSource },
    });

    resolveReport.log.event('Resolving name', { name: withActiveTld(`app.${label}`), backend });
    const cid = await names.resolveProduct(label, {
      onPhase: phase => {
        progress.resolvePhase(phase);
        debugBus.emit({
          layer: 'resolve',
          event: 'phase',
          flowId: resolveFlowId,
          timestamp: timers.now(),
          payload: { label, phase },
        });
      },
    });

    debugBus.emit({
      layer: 'resolve',
      event: 'completed',
      flowId: resolveFlowId,
      timestamp: timers.now(),
      payload: { label, source: resolveSource, cid, durationMs: readClock() - resolveStart },
    });

    progress.markNameResolved();
    performance.mark('dotli:resolve:end');
    log.debug(
      `[dot.li resolve] RESOLVED ${withActiveTld(label)} via ${backend} in ${formatDuration(resolveStart, { now: readClock() })} (total ${formatElapsed(startedAt, { now: readClock() })}) -> ${cid ?? 'null'}`,
    );
    resolveReport.log.event(cid === null ? 'Name has no contenthash' : 'Name resolved', {
      ms: Math.round(readClock() - resolveStart),
      ...(cid !== null ? { cid } : {}),
    });

    trace.recordNameResolved(cid);
    return cid;
  }

  // The core boots while the name resolves. The render awaits it and reports its failure, and a load that ends earlier
  // reports its own outcome instead.
  const coreHold = markHandled(ports.core.acquirePageCore());
  try {
    const cached = await readCachedCopy();
    if (cached !== null) {
      await loadCached(cached);
      return;
    }
    await loadCold();
  } catch (error) {
    performance.mark('dotli:main:end');
    failLoad(error);
  } finally {
    // This lease covers the wait before the render, so the load lets it go when it ends. A core that failed to boot let
    // it go itself.
    void coreHold.then(lease => {
      lease.release();
    }, noop);
  }
}

function getCidCacheResult(cachedCid: string | null, skipped: boolean): CidCacheResult {
  if (cachedCid !== null) {
    return 'hit';
  }
  return skipped ? 'skipped' : 'miss';
}
