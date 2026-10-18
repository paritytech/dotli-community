// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes a `.dot` label to a product on screen, or to the screen that says why not: the CID cache or the name, the
// manifests' verdict, the render and the content's outcome. What sits in another frame or origin (the name source, the
// product frame, the recent list) and what reloads or writes the page (the CID cache, the failure screen) is passed in.
// The page's own state is imported.

import { getActiveTldSuffix, getNetwork, isVerifiedSession, withActiveTld, type Backend } from '@dotli/config';
import { bitswapGet } from '@dotli/bitswap';
import { captureException, m, spans as S } from '@dotli/metrics';
import { protocolClient, type ProtocolVersionMismatchError } from '@dotli/protocol';
import { createAsyncTaskPool, dur, elapsed, errorMessage, log, randomId, serializeError } from '@dotli/shared';
import type { CachedManifests } from '@dotli/storage';
import { emitDotliDebugEvent } from '@dotli/truapi-debug';
import { readChatCapability } from './chat-capability.js';
import { describeError } from './errors.js';
import { beginAttempt, endJourney } from './journey.js';
import type { LoadFailure } from './load-failure.js';
import { startLoadProgress, type LoadEvents } from './load-progress.js';
import { assertLaunchable, fromCache, manifestFacts, toCache, type ProductManifests } from './manifest-gate.js';
import type { NameSource } from './name-source.js';
import { showNoContentError } from './no-content-page.js';
import { watchSandbox } from './sandbox-watch.js';
import { applyProductBranding } from './product-branding.js';
import type { RecentLabels } from './recent-labels.js';
import { startResolutionTrace, type CidCacheResult } from './resolution-trace.js';
import type { ProductFrame } from './runtime/product-frame.js';
import { loggedInStore } from './runtime/state/auth.js';
import { setProductError } from './runtime/state/product.js';
import { startShieldAutoHide } from './shield-autohide.js';
import { setVerificationShieldState, showProductPill, type ShieldState } from './state/url-pill.js';
import { armTopbarAutoHide, setProductContentShown } from './topbar-autohide.js';

/** Ends the load from inside its render, once a failure the render heard was reported and shown. */
class LoadEndedError extends Error {
  constructor() {
    super('The load ended during its render');
    this.name = 'LoadEndedError';
  }
}

/** The sandbox's one report on the content it was handed. */
export type ContentOutcome = 'loaded' | 'failed';

export interface LoaderFrame {
  /** Names the product before anything resolves, so a login clicked meanwhile boots its core rather than a second one. */
  setPageProduct: (product: { label: string }) => void;
  /** Mounts the product's sandbox on this content. Settles once the sandbox owns the download. */
  render: ProductFrame['render'];
  /** Takes the product down for good under the failure screen, which nothing the frame does later clears. */
  halt: ProductFrame['halt'];
  /** Called once, for the first outcome the sandbox reports on its content. */
  onContentDone: (callback: (outcome: ContentOutcome, failedStep: string | undefined) => void) => void;
  /** The content fetch's progress, as the sandbox's blocks pass through this window. Returns its unsubscribe. */
  onContentProgress: LoadEvents['onContentProgress'];
  /** Hears each message the sandbox sends about its load. Returns its unsubscribe. */
  onSandboxHeard: (listener: () => void) => () => void;
}

/** The CID cache for this network. Writes and checks wait for the page to be idle, so they never hold a render back. */
export interface LoaderCidCache {
  get: (label: string) => Promise<{ cid: string; manifests: CachedManifests } | null>;
  /** Keeps the label's content for the next load. */
  storeLater: (label: string, cid: string, manifests: CachedManifests) => void;
  /** Checks a served copy against the network. `onScreen` is false when the copy was refused rather than rendered. */
  revalidateLater: (label: string, servedCid: string, onScreen: boolean) => void;
}

/** The failure's screen, and the sighting that lets a failure a reload did not fix offer more. */
export interface LoaderFailureScreen {
  show: (failure: LoadFailure) => void;
  /** The previous attempt's failure is behind the visitor. */
  forget: () => void;
}

export interface ProductLoaderOptions {
  backend: Backend;
  skipCidCache: boolean;
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** `performance.now()` at page load. */
  startedAt: number;
  names: NameSource;
  frame: LoaderFrame;
  /** The page path ahead of the product's own, which its frame does not get. */
  base?: string | undefined;
  cidCache: LoaderCidCache;
  /** The names this visitor opened, kept in the store every subdomain shares. */
  recents: Pick<RecentLabels, 'record'>;
  failureScreen: LoaderFailureScreen;
  /**
   * Hears once that a protocol frame refused this page's wire version, at once if one already did. Returns its
   * unsubscribe.
   */
  onProtocolVersionMismatch: (listener: (error: ProtocolVersionMismatchError) => void) => () => void;
}

export interface ProductLoader {
  /** Loads the page's product. Repeating it for the same label waits for that load and does nothing more. */
  load: (label: string) => Promise<void>;
}

export function createProductLoader(options: ProductLoaderOptions): ProductLoader {
  const loads = createAsyncTaskPool({ poolSize: 1 });
  const loaded = new Set<string>();
  return {
    load: label =>
      loads.call(async () => {
        if (loaded.has(label)) {
          return;
        }
        loaded.add(label);
        await loadProduct(label, options);
      }),
  };
}

async function loadProduct(label: string, options: ProductLoaderOptions): Promise<void> {
  const { backend, names, frame, cidCache, flowId, startedAt } = options;
  const protocol = protocolClient();
  const attempt = beginAttempt(label);
  log.event('Route: app', { flow: 'boot', label, attempt: attempt.attemptNumber, entry: attempt.entry });
  // On every event, so errors and the resolution span join into journeys without a second id.
  m.setDefaults({
    journey_id: attempt.journeyId,
    attempt_number: String(attempt.attemptNumber),
    entry: attempt.entry,
  });
  frame.setPageProduct({ label });

  // In parallel with the CID. The frame awaits it before it connects the product, whose execution kind it picks.
  const chat = readChatCapability(label, async () => {
    const result = await names.readWorkerManifest(label);
    return result.kind === 'ok' && result.value.kind === 'worker' && result.value.includes.chat === true;
  });

  showProductPill(label, getActiveTldSuffix());

  // The shield shows how the content was checked, and the topbar may fold from then on.
  const shieldState: ShieldState = isVerifiedSession(backend) ? 'verified' : 'trusted';
  const autoHide = startShieldAutoHide({ loggedIn: loggedInStore, arm: armTopbarAutoHide });
  const settleShield = (): void => {
    setVerificationShieldState(shieldState);
    autoHide.settle();
  };

  const trace = startResolutionTrace({
    domain: withActiveTld(label),
    network: getNetwork(),
    backend,
    attempt,
    startedAt,
  });
  // For the trace's `loading_phase` and the capture below.
  let step = 'resolve_setup';
  const enterStep = (next: string): void => {
    step = next;
    trace.step(next);
  };
  const events: LoadEvents = {
    onChainSync: protocol.onProtocolChainSync,
    onChainDetail: protocol.onProtocolChainDetail,
    onNetBytes: protocol.onProtocolNetBytes,
    onContentProgress: frame.onContentProgress,
  };
  const progress = startLoadProgress({ label, backend, flowId, events, trace });

  // Read in the catch below, so a warm-path failure is not counted against the cold path.
  let cidCacheResult: CidCacheResult | 'unknown' = 'unknown';

  // "n/a" where no light client gates the render, keeping "unknown" for a signal that should have arrived.
  const smoldotDbCacheTags = (): Record<string, string> => {
    const inapplicable = cidCacheResult === 'hit' || backend === 'rpc-gateway';
    return {
      smoldotdb_relay_cache: inapplicable ? 'n/a' : protocol.getSmoldotDbOutcome('relay'),
      smoldotdb_hub_cache: inapplicable ? 'n/a' : protocol.getSmoldotDbOutcome('assethub'),
      smoldotdb_bulletin_cache: inapplicable ? 'n/a' : protocol.getSmoldotDbOutcome('bulletin'),
    };
  };

  let resolveFailed = false;
  /** Reports the failure and shows its screen. Throws what the screen threw. */
  const failLoad = (err: unknown): void => {
    resolveFailed = true;
    // One verdict drives both the report and the error page, so `error_kind` counts exactly the screens shown.
    const error = describeError(err, backend !== 'rpc-gateway');
    // Reported before rendering, in case rendering throws, and while the trace is still open, so the error lands in it.
    const dependency = backend === 'rpc-gateway' ? 'asset-hub-rpc' : 'smoldot';
    captureException(err, {
      flow: 'resolve',
      step,
      span: trace.span,
      tags: {
        outcome: 'error',
        error_kind: error.kind,
        dependency,
        cid_cache: cidCacheResult,
        ...smoldotDbCacheTags(),
        chain_backend: backend,
      },
    });
    trace.finish('error', { reason: errorMessage(err), errorKind: error.kind });
    log.debug(`[dot.li] Resolution failed via ${dependency}: ${serializeError(err)}`);
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'failed',
      flowId,
      timestamp: Date.now(),
      payload: { label, reason: errorMessage(err), dependency },
    });
    // Once for the failed load, however many times the user moves between its error screens.
    setProductError();
    options.failureScreen.show({ error, cause: err, label, backend });
  };
  /**
   * Ends a load whose product is already on screen, which only a reload can bring back, so the frame stops showing it
   * again. A screen that fails is reported here, since nothing waits on the load anymore.
   */
  const failAfterHandoff = (err: unknown, failure: string): void => {
    if (resolveFailed) {
      return;
    }
    frame.halt();
    try {
      failLoad(err);
    } catch (screenError: unknown) {
      captureException(screenError, { flow: 'resolve', step: 'failure_screen' });
      log.error(`[dot.li] The failure screen for ${failure} failed:`, screenError);
    }
  };
  // The content fetch outlives the handoff, so the trace waits for the sandbox's report. Subscribed before the
  // handoff, since a cached archive can report before it returns.
  const settleOnContent = (): void => {
    frame.onContentDone((outcome, failedStep) => {
      if (resolveFailed) {
        return;
      }
      setProductContentShown(outcome === 'loaded');
      if (outcome === 'loaded') {
        log.event('Content loaded', { flow: 'content' });
        endJourney();
        trace.finish('rendered');
        return;
      }
      log.event('Content failed', { flow: 'content', failed_step: failedStep ?? 'unknown' });
      trace.finish('content_error', failedStep !== undefined ? { failedStep } : {});
    });
  };
  const render = async (cid: string, manifests: ProductManifests): Promise<void> => {
    progress.contentFetch();
    enterStep('render_handoff');
    settleOnContent();
    const sandbox = watchSandbox(frame.onSandboxHeard);
    await frame.render({ mode: 'subdomain', label, cid, base: options.base, chat, ...manifestFacts(manifests) });
    // A protocol frame rebuilt while the app is open can come from a newer release. It refuses this page for good, and
    // the app would sit there with no chain or store, so the reload screen replaces it.
    options.onProtocolVersionMismatch(err => {
      failAfterHandoff(err, 'a protocol version mismatch');
    });
    // A refusal during the render was heard just now and ended the load, so nothing after the render runs.
    if (resolveFailed) {
      sandbox.stop();
      throw new LoadEndedError();
    }
    // From the handoff, since the render before it can wait on the shared store for as long as the protocol frame is down.
    void sandbox.expectWithin().catch((err: unknown) => {
      failAfterHandoff(err, 'a silent sandbox');
    });
  };
  const rendered = (manifests: ProductManifests): void => {
    options.failureScreen.forget();
    void options.recents.record(label);
    void applyProductBranding(label, manifests, { fetchBlock: bitswapGet });
  };
  const handedOff = (): void => {
    trace.handedOff();
    enterStep('content');
  };
  const ready = (path: 'fast' | 'slow'): void => {
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'ready',
      flowId,
      timestamp: Date.now(),
      payload: { label, totalMs: performance.now() - startedAt, path },
    });
  };

  try {
    enterStep('cid_cache_read');
    const cached = options.skipCidCache ? null : await cidCache.get(label);
    const cachedCid = cached?.cid ?? null;
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'cid_cache_checked',
      flowId,
      timestamp: Date.now(),
      payload: { label, hit: cachedCid !== null, ...(cachedCid !== null ? { cid: cachedCid } : {}) },
    });
    cidCacheResult = cachedCid !== null ? 'hit' : options.skipCidCache ? 'skipped' : 'miss';
    trace.cidCache(cidCacheResult);
    if (cached !== null) {
      m.count(S.CACHE_READ, { outcome: 'hit', surface: 'cid_cache' });
      log.event('CID cache hit', { flow: 'resolve', cid: cached.cid });
      trace.nameResolved(cached.cid);
      // A copy that no longer passes is refused but kept: only a cleanup or a redeploy drops cached manifests.
      const cachedManifests = fromCache(cached.manifests);
      enterStep('cached_launch_gate');
      try {
        assertLaunchable(cachedManifests.root, cachedManifests.app);
      } catch (err) {
        cidCache.revalidateLater(label, cached.cid, false);
        throw err;
      }
      await m.span(S.E2E_FAST, async () => {
        settleShield();
        await render(cached.cid, cachedManifests);
      });
      rendered(cachedManifests);
      performance.mark('dotli:main:end');
      log.event('Sandbox mounted', {
        flow: 'resolve',
        path: 'cache',
        total_ms: Math.round(performance.now() - startedAt),
      });
      ready('fast');
      handedOff();
      // Keeps the cache honest without blocking the render.
      cidCache.revalidateLater(label, cached.cid, true);
      return;
    }
    if (cidCacheResult === 'miss') {
      m.count(S.CACHE_READ, { outcome: 'miss', surface: 'cid_cache' });
    }
    log.event(cidCacheResult === 'skipped' ? 'CID cache skipped by settings' : 'CID cache miss', { flow: 'resolve' });

    // Wall-clock, since a span detaches across the smoldot path's postMessage awaits.
    const coldStartMs = performance.now();
    performance.mark('dotli:resolve:start');
    // In parallel with the CID, and awaited before anything renders, so a refused product is never downloaded.
    const manifestsRead = names.readManifests(label);
    manifestsRead.catch(() => {
      /* Awaited below. A CID failure first must not leave this unhandled. */
    });
    enterStep('name_resolve');
    const resolveStart = performance.now();

    const resolveFlowId = randomId();
    const resolveSource: 'smoldot' | 'rpc-gateway' = backend !== 'rpc-gateway' ? 'smoldot' : 'rpc-gateway';
    emitDotliDebugEvent({
      layer: 'resolve',
      event: 'started',
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: { label, source: resolveSource },
    });

    log.event('Resolving name', { flow: 'resolve', name: withActiveTld(`app.${label}`), backend });
    const cid = await names.resolveProduct(label, phase => {
      progress.resolvePhase(phase);
      emitDotliDebugEvent({
        layer: 'resolve',
        event: 'phase',
        flowId: resolveFlowId,
        timestamp: Date.now(),
        payload: { label, phase },
      });
    });

    emitDotliDebugEvent({
      layer: 'resolve',
      event: 'completed',
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: { label, source: resolveSource, cid, durationMs: performance.now() - resolveStart },
    });

    progress.nameResolved();
    performance.mark('dotli:resolve:end');
    log.debug(
      `[dot.li resolve] RESOLVED ${withActiveTld(label)} via ${backend} in ${dur(resolveStart)} (total ${elapsed(startedAt)}) -> ${cid ?? 'null'}`,
    );
    log.event(cid === null ? 'Name has no contenthash' : 'Name resolved', {
      flow: 'resolve',
      ms: Math.round(performance.now() - resolveStart),
      ...(cid !== null ? { cid } : {}),
    });

    trace.nameResolved(cid);

    // Nothing to launch whatever the manifests say, so it does not wait on them.
    if (cid === null) {
      // Its recent pill stays: the name may still resolve on another network.
      showNoContentError(label);
      setProductError();
      endJourney();
      trace.finish('no_content');
      performance.mark('dotli:main:end');
      return;
    }

    enterStep('manifest_read');
    const manifests = await manifestsRead;
    log.event('Manifests read', { flow: 'resolve', root: manifests.root.kind, app: manifests.app.kind });
    enterStep('launch_gate');
    assertLaunchable(manifests.root, manifests.app);

    if (!options.skipCidCache) {
      cidCache.storeLater(label, cid, toCache(manifests));
    }

    settleShield();
    await render(cid, manifests);
    rendered(manifests);

    m.distribution(S.E2E_SLOW, performance.now() - coldStartMs, 'millisecond', {
      outcome: 'ok',
      chain_backend: backend,
    });
    performance.mark('dotli:main:end');
    log.event('Sandbox mounted', {
      flow: 'resolve',
      path: 'cold',
      total_ms: Math.round(performance.now() - startedAt),
    });
    handedOff();
    ready('slow');
  } catch (err) {
    performance.mark('dotli:main:end');
    if (err instanceof LoadEndedError) {
      return;
    }
    failLoad(err);
  }
}
