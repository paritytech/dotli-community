// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes a `.dot` label to a product on screen, or to the screen that says why not: the CID cache or the name, the
// manifests' verdict, the render and the content's outcome. Every source and screen is passed in.

import { getActiveTldSuffix, isVerifiedSession, withActiveTld, type Backend } from '@dotli/config';
import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, dur, elapsed, log, randomId, serializeError } from '@dotli/shared';
import type { SmoldotDbChain } from '@dotli/protocol';
import type { CachedManifests } from '@dotli/storage';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import type { ShieldState } from './state/url-pill.js';
import type { ProductFrame } from './runtime/product-frame.js';
import { describeError } from './errors.js';
import type { Attempt } from './journey.js';
import type { LoadFailure } from './load-failure.js';
import type { LoadProgress } from './load-progress.js';
import { assertLaunchable, fromCache, manifestFacts, toCache, type ProductManifests } from './manifest-gate.js';
import type { NameSource } from './name-source.js';
import type { CidCacheResult, ResolutionTrace, ResolutionTraceOptions } from './resolution-trace.js';

/** What the loader draws the product with. */
export interface LoaderFrame {
  /** Names the product before anything resolves, so a login clicked meanwhile boots its core rather than a second one. */
  setPageProduct: (product: { label: string }) => void;
  /** Mounts the product's sandbox on this content. Settles once the sandbox owns the download. */
  render: ProductFrame['render'];
}

/** The sandbox's one report on the content it was handed. */
export type ContentOutcome = 'loaded' | 'failed';

export interface ProductLoaderDeps {
  backend: Backend;
  skipCidCache: boolean;
  network: () => string;
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** `performance.now()` at page load. */
  startedAt: number;
  emit: (event: DotliDebugEvent) => void;
  frame: LoaderFrame;
  names: NameSource;
  cidCache: {
    get: (label: string) => Promise<{ cid: string; manifests: CachedManifests } | null>;
    set: (label: string, cid: string, manifests: CachedManifests) => Promise<void>;
  };
  journey: { begin: (label: string) => Attempt; end: () => void };
  startTrace: (options: ResolutionTraceOptions) => ResolutionTrace;
  startProgress: (load: { label: string; trace: ResolutionTrace }) => LoadProgress;
  /** Called once, for the first outcome the sandbox reports. */
  onContentDone: (callback: (outcome: ContentOutcome, failedStep: string | undefined) => void) => void;
  smoldotDbOutcome: (chain: SmoldotDbChain) => string;
  /** Whether the product's worker manifest asks for chat, read alongside the name and cached for the next load. */
  readChat: (label: string, read: () => Promise<boolean>) => Promise<boolean>;
  scheduleNotifications: (options: { label: string }) => void;
  /** Never rejects. */
  revalidate: (label: string, servedCid: string, onScreen: boolean) => Promise<void>;
  /** Never rejects. */
  brand: (label: string, manifests: ProductManifests) => Promise<void>;
  page: {
    showProductPill: (label: string, tld: string) => void;
    /** The shield shows how the content was checked, and the topbar may fold from here on. */
    settleShield: (state: ShieldState) => void;
    showNoContent: (label: string) => void;
    setProductError: () => void;
    setContentShown: (shown: boolean) => void;
    recordRecentLabel: (label: string) => Promise<void>;
  };
  /** Shows the failure's screen. */
  presentFailure: (failure: LoadFailure) => void;
  /** The previous attempt's failure is behind the visitor. */
  forgetFailure: () => void;
  idle: (callback: () => void) => void;
}

export interface ProductLoader {
  /** Loads the page's product. Repeating it for the same label waits for that load and does nothing more. */
  load: (label: string) => Promise<void>;
}

export function createProductLoader(deps: ProductLoaderDeps): ProductLoader {
  const loads = createAsyncTaskPool({ poolSize: 1 });
  const loaded = new Set<string>();
  return {
    load: label =>
      loads.call(async () => {
        if (loaded.has(label)) {
          return;
        }
        loaded.add(label);
        await loadProduct(label, deps);
      }),
  };
}

async function loadProduct(label: string, deps: ProductLoaderDeps): Promise<void> {
  const { backend, names, emit, flowId, startedAt } = deps;
  const attempt = deps.journey.begin(label);
  log.event('Route: app', { flow: 'boot', label, attempt: attempt.attemptNumber, entry: attempt.entry });
  // On every event, so errors and the resolution span join into journeys without a second id.
  m.setDefaults({
    journey_id: attempt.journeyId,
    attempt_number: String(attempt.attemptNumber),
    entry: attempt.entry,
  });
  deps.frame.setPageProduct({ label });

  deps.scheduleNotifications({ label });

  // In parallel with the CID. The frame awaits it before it connects the product, whose execution kind it picks.
  const chat = deps.readChat(label, async () => {
    const result = await names.readWorkerManifest(label);
    return result.kind === 'ok' && result.value.kind === 'worker' && result.value.includes.chat === true;
  });

  deps.page.showProductPill(label, getActiveTldSuffix());

  const shieldState: ShieldState = isVerifiedSession(backend) ? 'verified' : 'trusted';

  const trace = deps.startTrace({
    domain: withActiveTld(label),
    network: deps.network(),
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
  const progress = deps.startProgress({ label, trace });

  // Read in the catch below, so a warm-path failure is not counted against the cold path.
  let cidCache: CidCacheResult | 'unknown' = 'unknown';

  // "n/a" where no light client gates the render, keeping "unknown" for a signal that should have arrived.
  const smoldotDbCacheTags = (): Record<string, string> => {
    const inapplicable = cidCache === 'hit' || backend === 'rpc-gateway';
    return {
      smoldotdb_relay_cache: inapplicable ? 'n/a' : deps.smoldotDbOutcome('relay'),
      smoldotdb_hub_cache: inapplicable ? 'n/a' : deps.smoldotDbOutcome('assethub'),
      smoldotdb_bulletin_cache: inapplicable ? 'n/a' : deps.smoldotDbOutcome('bulletin'),
    };
  };

  // The content fetch outlives the handoff, so the trace waits for the sandbox's report. Subscribed before the
  // handoff, since a cached archive can report before it returns.
  let resolveFailed = false;
  const settleOnContent = (): void => {
    deps.onContentDone((outcome, failedStep) => {
      if (resolveFailed) {
        return;
      }
      deps.page.setContentShown(outcome === 'loaded');
      if (outcome === 'loaded') {
        log.event('Content loaded', { flow: 'content' });
        deps.journey.end();
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
    await deps.frame.render({ mode: 'subdomain', label, cid, chat, ...manifestFacts(manifests) });
  };
  const rendered = (manifests: ProductManifests): void => {
    deps.forgetFailure();
    void deps.page.recordRecentLabel(label);
    void deps.brand(label, manifests);
  };
  const revalidateLater = (servedCid: string, onScreen: boolean): void => {
    deps.idle(() => {
      void deps.revalidate(label, servedCid, onScreen);
    });
  };
  const handedOff = (): void => {
    trace.handedOff();
    enterStep('content');
  };
  const ready = (path: 'fast' | 'slow'): void => {
    emit({
      layer: 'boot',
      event: 'ready',
      flowId,
      timestamp: Date.now(),
      payload: { label, totalMs: performance.now() - startedAt, path },
    });
  };

  try {
    enterStep('cid_cache_read');
    const cached = deps.skipCidCache ? null : await deps.cidCache.get(label);
    const cachedCid = cached?.cid ?? null;
    emit({
      layer: 'boot',
      event: 'cid_cache_checked',
      flowId,
      timestamp: Date.now(),
      payload: { label, hit: cachedCid !== null, ...(cachedCid !== null ? { cid: cachedCid } : {}) },
    });
    cidCache = cachedCid !== null ? 'hit' : deps.skipCidCache ? 'skipped' : 'miss';
    trace.cidCache(cidCache);
    if (cached !== null) {
      m.count(S.CACHE_HIT);
      log.event('CID cache hit', { flow: 'resolve', cid: cached.cid });
      trace.nameResolved(cached.cid);
      // A copy that no longer passes is refused but kept: only a cleanup or a redeploy drops cached manifests.
      const cachedManifests = fromCache(cached.manifests);
      enterStep('cached_launch_gate');
      try {
        assertLaunchable(cachedManifests.root, cachedManifests.app);
      } catch (err) {
        revalidateLater(cached.cid, false);
        throw err;
      }
      await m.span(S.E2E_FAST, async () => {
        deps.page.settleShield(shieldState);
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
      revalidateLater(cached.cid, true);
      return;
    }
    if (cidCache === 'miss') {
      m.count(S.CACHE_MISS);
    }
    log.event(cidCache === 'skipped' ? 'CID cache skipped by settings' : 'CID cache miss', { flow: 'resolve' });

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
    emit({
      layer: 'resolve',
      event: 'started',
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: { label, source: resolveSource },
    });

    log.event('Resolving name', { flow: 'resolve', name: withActiveTld(`app.${label}`), backend });
    const cid = await names.resolveProduct(label, phase => {
      progress.resolvePhase(phase);
      emit({
        layer: 'resolve',
        event: 'phase',
        flowId: resolveFlowId,
        timestamp: Date.now(),
        payload: { label, phase },
      });
    });

    emit({
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
      deps.page.showNoContent(label);
      deps.page.setProductError();
      deps.journey.end();
      trace.finish('no_content');
      performance.mark('dotli:main:end');
      return;
    }

    enterStep('manifest_read');
    const manifests = await manifestsRead;
    log.event('Manifests read', { flow: 'resolve', root: manifests.root.kind, app: manifests.app.kind });
    enterStep('launch_gate');
    assertLaunchable(manifests.root, manifests.app);

    if (!deps.skipCidCache) {
      deps.idle(() => {
        void deps.cidCache.set(label, cid, toCache(manifests));
      });
    }

    deps.page.settleShield(shieldState);
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
    resolveFailed = true;
    performance.mark('dotli:main:end');
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
        cid_cache: cidCache,
        ...smoldotDbCacheTags(),
        chain_backend: backend,
      },
    });
    trace.finish('error', { reason: err instanceof Error ? err.message : String(err), errorKind: error.kind });
    log.debug(`[dot.li] Resolution failed via ${dependency}: ${serializeError(err)}`);
    emit({
      layer: 'boot',
      event: 'failed',
      flowId,
      timestamp: Date.now(),
      payload: { label, reason: err instanceof Error ? err.message : String(err), dependency },
    });
    // Once for the failed load, however many times the user moves between its error screens.
    deps.page.setProductError();
    deps.presentFailure({ error, cause: err, label, backend });
  }
}
