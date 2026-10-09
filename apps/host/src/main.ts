// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import './pwa.js';
import {
  boot,
  createBootFlowId,
  reportBootFailure,
  resolveTruapiDebugMode,
  startHost,
  T0,
  type EmitFn,
} from './startup.js';
import { parseDotLabel } from './dot-label.js';
import { captureException, m, spans as S } from '@dotli/metrics';
import {
  SETTINGS_GLYPH,
  RELOAD_GLYPH,
  openSettings,
  showError,
  showErrorPage,
  showNoContentError,
  initPhases,
  advancePhase,
  nudgePhaseProgress,
  onProgressStall,
  releasePhaseProgress,
  setLoadingDomain,
  setLoadingStage,
  setLoadingWarning,
  stopStatusTick,
  listenForSandboxStatus,
  onSandboxDone,
  chainRoleForKey,
  recordChainPhase,
  recordPeerCount,
  recordTransfer,
  type ChainPhase,
  armTopbarAutoHide,
  setProductContentShown,
  setVerificationShieldState,
  showLocalhostPill,
  showProductPill,
  recordRecentLabel,
  showNotification,
  initScheduledNotifications,
  loadTruapiDebugMount,
  loadBridge,
} from '@dotli/ui';

import type { LoadingPhase, ShieldState, BridgeModule as RenderModule } from '@dotli/ui';
import type { ChainSyncKind, ResolvePhase } from '@dotli/resolver';

import type { ChainRole } from '@dotli/config';
import { createChainPhaseTracker, startResolutionTrace, type CidCacheResult } from './resolution-trace.js';
import { beginAttempt, endJourney } from './journey.js';

import {
  describeProgressStall,
  describeStall,
  isCriticalChain,
  STALL_WARNING_MS,
  WARNING_MIN_LOAD_MS,
  type CriticalChain,
} from './warnings.js';

import { bitswapGet, listenForSandboxBitswap, onContentProgress } from '@dotli/content';
import {
  getSmoldotDbOutcome,
  onProtocolChainDetail,
  onProtocolChainSync,
  onProtocolNetBytes,
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
  resolveRootManifestRemote,
} from '@dotli/protocol';
import {
  evictCachedCid,
  getCachedCid,
  setCachedCid,
  deleteCachedBlock,
  getCachedBlock,
  pruneBlockCache,
  putCachedBlock,
} from '@dotli/storage';

import {
  dur,
  elapsed,
  setActiveAppManifest,
  setActiveRootManifest,
  primeChatCapability,
  setChatCapability,
  log,
  markContinuation,
  serializeError,
  dotNsUrl,
} from '@dotli/shared';

import {
  BASE_DOMAIN,
  BLOCK_CACHE_MAX_BYTES,
  DEBUG,
  SITE_ID,
  isLocalhost,
  setBackend,
  isVerifiedSession,
  getCacheSettings,
  type Backend,
  getActiveTldSuffix,
  getNetwork,
  getTldSuffix,
  parseSettingsFromSearch,
  peekNetwork,
  withActiveTld,
  writeSettingsToSearch,
} from '@dotli/config';

import type { DotliDebugEvent } from '@dotli/truapi-debug';
import {
  describeError,
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  trustedProviderHosts,
  trustedProviderWarning,
  TRY_ANYWAY_BTN_LABEL,
} from './errors.js';
import {
  assertLaunchable,
  fromCache,
  revalidateCachedProduct,
  toCache,
  type ProductManifests,
} from './manifest-gate.js';
import { parsePreviewTargetUrl } from './preview-route.js';

const resolveLog = log.child({ flow: 'resolve' });

// Sampled rather than emitted per step, or a long warp crowds the debug panel's ring buffer.
const CHAIN_WARP_DEBUG_MS = 1000;
// Every other 500ms byte total, which still resolves the peak.
const CHAIN_BYTES_DEBUG_MS = 1000;
/** For a load that never renders. */
const CHAIN_BYTES_DEBUG_MAX = 300;
const DOTLI_PRODUCT_ID_PARAM = 'dotliProductId';
const ICON_FETCH_BUDGET_MS = 10_000;

function parseLocalProductIdOverride(): string | undefined {
  if (!isLocalhost) {
    return undefined;
  }
  const value = new URLSearchParams(window.location.search).get(DOTLI_PRODUCT_ID_PARAM);
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const productId = value.trim();
  return dotNsUrl.isProductIdentifier(productId) ? productId : undefined;
}

/**
 * Debug builds only: proxying a visitor's localhost into the trusted host origin is dangerous in production, and the
 * compile-time flag keeps this path out of production bundles.
 */
function parseLocalhostUrl(): string | null {
  if (!DEBUG) {
    return null;
  }
  const path = window.location.pathname;
  const match = /^\/(localhost(?::\d+)?)(.*)$/.exec(path);
  if (match === null) {
    return null;
  }
  const [, host, rest = ''] = match;
  if (host === undefined) {
    return null;
  }
  // Reserved host params must not leak into the proxied product.
  const productSearch = new URLSearchParams(window.location.search);
  for (const k of RESERVED_HOST_PARAMS) {
    productSearch.delete(k);
  }
  const query = productSearch.toString();
  return `http://${host}${rest}${query ? `?${query}` : ''}${window.location.hash}`;
}

const RESERVED_HOST_PARAMS = [
  'network',
  'chainBackend',
  'skipArchiveCache',
  'skipCidCache',
  'skipWorkerCache',
  'fullReset',
  'v',
  DOTLI_PRODUCT_ID_PARAM,
] as const;

// Login arms the topbar auto-hide only once the shield has settled.
let shieldVerified = false;

// Signed out, the bar folds all the same: sign-in stays one reveal away.
function bindTopbarAutoHide(): void {
  window.addEventListener('dotli:authenticated', () => {
    if (shieldVerified && !(DEBUG && document.documentElement.classList.contains('experimental-wallet-active'))) {
      armTopbarAutoHide();
    }
  });
}

function setShieldState(state: ShieldState): void {
  setVerificationShieldState(state);
  shieldVerified = true;
  if (!(DEBUG && document.documentElement.classList.contains('experimental-wallet-active'))) {
    armTopbarAutoHide();
  }
}

async function readProductManifests(label: string, chainBackend: Backend): Promise<ProductManifests> {
  if (chainBackend === 'rpc-gateway') {
    const mod = await loadRpcResolve();
    const [root, app] = await Promise.all([
      mod.resolveRootManifestViaRpc(label),
      mod.resolveExecutableManifestViaRpc(label, 'app'),
    ]);
    return { root, app };
  }
  const [root, app] = await Promise.all([
    resolveRootManifestRemote(label),
    resolveExecutableManifestRemote(label, 'app'),
  ]);
  return { root, app };
}

/** Runs after the app iframe renders, so the icon fetch never blocks first paint. */
async function applyProductBranding(
  label: string,
  { root: rootResult, app: appResult }: ProductManifests,
): Promise<void> {
  if (rootResult.kind === 'ok') {
    const root = rootResult.value;
    document.title = root.displayName;
    setActiveRootManifest({
      schemaVersion: root.$v,
      displayName: root.displayName,
      description: root.description,
      icon: root.icon,
    });
    // Cosmetic, so a short budget: a missing icon must not hold smoldot request slots the content needs.
    const format: string = root.icon.format;
    // Any other format keeps the default icon, never sniffed or corrected, and the product stays launchable.
    if (format === 'jpeg' || format === 'png') {
      const iconAborter = new AbortController();
      const iconDeadline = setTimeout(() => {
        iconAborter.abort();
      }, ICON_FETCH_BUDGET_MS);
      try {
        const bytes = await bitswapGet(root.icon.cid, iconAborter.signal);
        const blob = new Blob([new Uint8Array(bytes)], {
          type: `image/${format}`,
        });
        setFavicon(URL.createObjectURL(blob), format);
        // Cosmetic: a failure must not affect the tab title or the app.
      } catch (err: unknown) {
        resolveLog.warn(`[dot.li manifest] icon fetch failed for ${withActiveTld(label)}:`, err);
      } finally {
        clearTimeout(iconDeadline);
      }
    }
  }
  if (appResult.kind === 'ok' && appResult.value.kind === 'app') {
    setActiveAppManifest({
      schemaVersion: appResult.value.$v,
      appVersion: appResult.value.appVersion,
    });
  }
}

function setFavicon(href: string, format: 'jpeg' | 'png'): void {
  const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  const link = existing ?? document.createElement('link');
  link.rel = 'icon';
  link.type = `image/${format}`;
  link.href = href;
  if (existing === null) {
    document.head.appendChild(link);
  }
}
import { loadDotliDebugBus } from '@dotli/truapi-debug';
import { loadRpcResolve as loadRpcResolveModule, loadResolve } from '@dotli/resolver';
import type { RpcResolveModule } from '@dotli/resolver';

let rpcResolveReady: Promise<RpcResolveModule> | null = null;

/** Wired to the host pool's Asset Hub connection before first use, since the resolver cannot import the pool. */
function loadRpcResolve(): Promise<RpcResolveModule> {
  if (rpcResolveReady !== null) {
    return rpcResolveReady;
  }
  const ready = Promise.all([loadRpcResolveModule(), loadBridge()]).then(([mod, bridge]) => {
    mod.setRpcAssetHubProvider(bridge.hostAssetHubProvider);
    return mod;
  });
  rpcResolveReady = ready;
  // A failed load is retried by the next call, unless a newer one is already under way.
  ready.catch(() => {
    if (rpcResolveReady === ready) {
      rpcResolveReady = null;
    }
  });
  return ready;
}
type RenderChunk = RenderModule;

/** Event-loop stalls and a heartbeat for the debug panel, until the bridge handshakes or MAX_MONITOR_MS passes. */
function startMainThreadMonitor(flowId: string, emit: EmitFn): void {
  const TICK_MS = 50;
  const STALL_THRESHOLD_MS = 150;
  const HEARTBEAT_INTERVAL_MS = 2_000;
  const MAX_MONITOR_MS = 120_000;

  const startedAt = performance.now();
  let lastTick = performance.now();
  let lastHeartbeat = startedAt;

  const handle = setInterval(() => {
    const now = performance.now();
    const delta = now - lastTick;
    const lag = delta - TICK_MS;

    if (lag > STALL_THRESHOLD_MS) {
      emit({
        layer: 'main',
        event: 'stall_detected',
        flowId,
        timestamp: Date.now(),
        payload: { durationMs: Math.round(lag) },
      });
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      emit({
        layer: 'main',
        event: 'heartbeat',
        flowId,
        timestamp: Date.now(),
        payload: {
          uptimeSec: Math.round((now - startedAt) / 1000),
        },
      });
    }

    lastTick = now;

    if (now - startedAt > MAX_MONITOR_MS) {
      clearInterval(handle);
      window.removeEventListener('dotli:debug:bridge-ready', onBridgeReady);
      emit({
        layer: 'main',
        event: 'monitor_stopped',
        flowId,
        timestamp: Date.now(),
        payload: { reason: 'max_duration' },
      });
    }
  }, TICK_MS);

  // The bridge dispatches this on its first outbound message.
  const onBridgeReady = (): void => {
    clearInterval(handle);
    window.removeEventListener('dotli:debug:bridge-ready', onBridgeReady);
    emit({
      layer: 'main',
      event: 'monitor_stopped',
      flowId,
      timestamp: Date.now(),
      payload: { reason: 'bridge_ready' },
    });
  };
  window.addEventListener('dotli:debug:bridge-ready', onBridgeReady, {
    once: true,
  });
}

/** The sandbox's origin cannot reach `emitDotliDebugEvent`. Sees every window message, so others must pass through. */
function listenForSandboxDebugEvents(emit: EmitFn): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; event?: unknown } | null | undefined;
    if (data === null || data === undefined || typeof data !== 'object' || data.type !== 'dotli:debug-event') {
      return;
    }
    const payload = data.event as (DotliDebugEvent & { layer?: unknown }) | null | undefined;
    if (payload === null || payload === undefined || typeof payload !== 'object' || payload.layer !== 'sandbox') {
      return;
    }
    try {
      emit(payload);
      // eslint-disable-next-line no-restricted-syntax -- best-effort forwarder. A malformed event from the sandbox must never break the host.
    } catch {
      /* ignore: a malformed event shouldn't kill the host */
    }
  });
}

/** `onScreen` is false when the cached copy was refused rather than rendered, so an eviction has no page to reload. */
async function runBackgroundRevalidate(
  label: string,
  servedCid: string,
  chainBackend: Backend,
  onScreen: boolean,
): Promise<void> {
  const stopTimer = m.timer(S.CACHE_REVALIDATE_LATENCY);
  try {
    const decision = await revalidateCachedProduct(
      servedCid,
      async () =>
        chainBackend === 'rpc-gateway'
          ? (await loadRpcResolve()).resolveDotNameViaRpc(label)
          : resolveDotNameRemote(label),
      () => readProductManifests(label, chainBackend),
    );
    stopTimer();
    if (decision.kind === 'keep') {
      m.count(S.CACHE_REVALIDATE_MATCH);
      return;
    }
    if (decision.kind === 'update') {
      await setCachedCid(label, getNetwork(), decision.cid, decision.manifests);
      m.count(S.CACHE_REVALIDATE_UPDATE);
      log.event('Cached app is outdated', { flow: 'resolve', served: servedCid, latest: decision.cid });
      showNotification({
        label: 'New version available',
        text: 'This site has been updated. Reload to see the latest version.',
        dismissMs: 0,
        action: {
          label: 'Reload',
          onClick: () => {
            markContinuation('app_update');
            window.location.reload();
          },
        },
      });
      return;
    }
    // Cleared, or redeployed with manifests this host cannot read. Reloading takes the cold path, which shows why.
    await evictCachedCid(label);
    m.count(S.CACHE_REVALIDATE_CLEARED);
    log.event('Cached app evicted', { flow: 'resolve', served: servedCid, reason: decision.reason });
    if (onScreen) {
      markContinuation('app_update');
      window.location.reload();
    }
  } catch (err) {
    stopTimer();
    m.count(S.CACHE_REVALIDATE_ERROR);
    captureException(err, {
      flow: 'resolve',
      step: 'cache_revalidate',
      tags: { kind: 'cid_cache_revalidate_error', surface: 'host_cache_revalidate' },
    });
  }
}

/**
 * The error kind of the previous attempt's recovery screen. Not consumed on read, so a failure that survives a reload
 * can offer a stronger remedy. Cleared on success, so it means "this reload did not help".
 */
const ERROR_SEEN_KEY = 'dotli:error-seen';

function errorAlreadySeen(kind: string): boolean {
  try {
    return sessionStorage.getItem(ERROR_SEEN_KEY) === kind;
  } catch {
    // Without sessionStorage every failure is a first sighting, which keeps the gentler screen.
    return false;
  }
}

function rememberError(kind: string): void {
  try {
    sessionStorage.setItem(ERROR_SEEN_KEY, kind);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode. Without it every failure stays a first sighting, which is the safe default.
  } catch {
    /* sessionStorage unavailable: the escalation simply never triggers */
  }
}

function forgetError(): void {
  try {
    sessionStorage.removeItem(ERROR_SEEN_KEY);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, in which case nothing was ever written and there is nothing to clear.
  } catch {
    /* sessionStorage unavailable: nothing was stored, so nothing to clear */
  }
}

function switchBackendAndReload(nextBackend: Backend): void {
  setBackend(nextBackend);
  const search = new URLSearchParams(window.location.search);
  if (
    writeSettingsToSearch(
      {
        network: getNetwork(),
        chainBackend: nextBackend,
        cache: getCacheSettings(),
      },
      search,
    )
  ) {
    const query = search.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', newUrl);
  }
  markContinuation('switch_backend');
  window.location.reload();
}

/**
 * The server answers the bare host's root with the landing page, so the shell gets a URL with no product only from a
 * service worker an older release registered there, or from a host or path that names none. Fails rather than reloads
 * when neither applies, as a server serving the shell for the landing URL would loop.
 */
async function leaveForLanding(): Promise<void> {
  const { protocol, port, pathname, search } = window.location;
  const origin = isLocalhost ? `${protocol}//localhost${port === '' ? '' : `:${port}`}` : `${protocol}//${BASE_DOMAIN}`;
  const registrations = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistrations() : [];
  if (registrations.length === 0 && origin === window.location.origin && pathname === '/') {
    throw new Error('the server answered the landing page URL with the shell');
  }
  await Promise.all(registrations.map(registration => registration.unregister()));
  log.event('Route: landing page elsewhere', { flow: 'boot', stale_workers: registrations.length });
  window.location.replace(`${origin}/${search}`);
}

async function main(): Promise<void> {
  const previewTargetUrl = parsePreviewTargetUrl(window.location);

  // No nested dot.li with a duplicate topbar.
  if (window.self !== window.top && previewTargetUrl === null) {
    return;
  }

  performance.mark('dotli:main:start');
  log.debug(`[dot.li perf] main() started (${elapsed(T0)})`);

  // From the URL alone, before any await, so the URL bar is drawn with the page. The TLD is a guess until settings
  // apply, and the app route below sets it again from them.
  const label = parseDotLabel();
  const localhostUrl = parseLocalhostUrl();
  const pageUrl = label === null ? (previewTargetUrl ?? localhostUrl) : null;
  const pageHost = pageUrl === null ? null : new URL(pageUrl).host;
  if (label !== null) {
    showProductPill(
      label,
      getTldSuffix(peekNetwork(parseSettingsFromSearch(new URLSearchParams(window.location.search)).network)),
    );
  } else if (pageHost !== null) {
    showLocalhostPill(pageHost);
  }

  // The panel's heavy chunk loads only on opt-in. Otherwise the bus stays a stub and every emit returns early.
  boot.step = 'debug_bus';
  const { emitDotliDebugEvent, enableDotliDebugBuffering } = await loadDotliDebugBus();
  const debugMode = resolveTruapiDebugMode();
  if (debugMode.enabled) {
    enableDotliDebugBuffering();
  }

  const bootFlowId = createBootFlowId();
  if (debugMode.enabled) {
    startMainThreadMonitor(bootFlowId, emitDotliDebugEvent);
    listenForSandboxDebugEvents(emitDotliDebugEvent);
  }

  const productIdOverride = parseLocalProductIdOverride();
  const pageProduct =
    label !== null ? { label } : pageHost !== null ? { label: pageHost, productId: productIdOverride } : undefined;
  const { chainBackend, cacheSettings, bridgeModule } = await startHost(
    bootFlowId,
    emitDotliDebugEvent,
    pageProduct,
  );

  // Wallet verification may acquire the page core as soon as the debug view
  // mounts. Its product selection must already be installed.
  if (debugMode.enabled) {
    void loadTruapiDebugMount().then(({ setupTruapiDebugPanel }) => {
      setupTruapiDebugPanel({
        startCollapsed: !debugMode.explicit,
        // The Archive tab reads the product's blocks the way the sandbox
        // relay serves them: from the block cache, else over bitswap.
        blockSource: async cid => (await getCachedBlock(cid)) ?? bitswapGet(cid),
        ...(DEBUG ? { experimentalWallet: bridgeModule.experimentalWalletControls } : {}),
      });
      log.event('TrUAPI debug panel enabled', { flow: 'boot' });
    });
  }

  if (previewTargetUrl !== null && pageHost !== null) {
    boot.step = 'preview_render';
    log.event('Route: preview', { flow: 'boot', host: pageHost });

    initScheduledNotifications({ label: pageHost });

    // Local products carry no worker manifest to read the chat flag from,
    // so the debug paths enable chat unconditionally for product testing.
    setChatCapability(pageHost, true);
    await bridgeModule.renderIframe(
      previewTargetUrl,
      pageHost,
      productIdOverride !== undefined ? { productId: productIdOverride } : {},
    );
    setProductContentShown(true);
    const nextSearch = new URLSearchParams({
      url: previewTargetUrl,
    });
    if (productIdOverride !== undefined) {
      nextSearch.set(DOTLI_PRODUCT_ID_PARAM, productIdOverride);
    }
    history.replaceState(null, '', `/__preview?${nextSearch.toString()}`);
    document.title = `${pageHost} · ${SITE_ID}`;
    performance.mark('dotli:main:end');
    return;
  }

  emitDotliDebugEvent({
    layer: 'boot',
    event: 'url_parsed',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {
      label,
      localhostHost: localhostUrl === null ? null : pageHost,
      deepPath: window.location.pathname + window.location.search,
    },
  });
  if (localhostUrl !== null && pageHost !== null) {
    boot.step = 'localhost_render';
    log.event('Route: localhost proxy', { flow: 'boot', host: pageHost });

    initScheduledNotifications({ label: pageHost });

    setChatCapability(pageHost, true);
    await bridgeModule.renderIframe(
      localhostUrl,
      pageHost,
      productIdOverride !== undefined ? { productId: productIdOverride } : {},
    );
    setProductContentShown(true);

    shieldVerified = true;
    bindTopbarAutoHide();
    if (!(DEBUG && document.documentElement.classList.contains('experimental-wallet-active'))) {
      armTopbarAutoHide();
    }

    // The product iframe got the deep path, so the URL bar must not show it stale.
    history.replaceState(
      null,
      '',
      productIdOverride === undefined
        ? '/' + pageHost
        : `/${pageHost}?${DOTLI_PRODUCT_ID_PARAM}=${encodeURIComponent(productIdOverride)}`,
    );
    document.title = `${pageHost} · ${SITE_ID}`;
    performance.mark('dotli:main:end');
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'ready',
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label: null,
        totalMs: performance.now() - T0,
        path: 'localhost',
      },
    });
    return;
  }

  if (label === null) {
    await leaveForLanding();
    return;
  }

  bindTopbarAutoHide();

  boot.step = 'resolve_setup';
  const attempt = beginAttempt(label);
  log.event('Route: app', {
    flow: 'boot',
    label,
    attempt: attempt.attemptNumber,
    entry: attempt.entry,
  });
  // On every event, so errors and the resolution span join into journeys without a second id.
  m.setDefaults({
    journey_id: attempt.journeyId,
    attempt_number: String(attempt.attemptNumber),
    entry: attempt.entry,
  });

  initScheduledNotifications({ label });

  // In parallel with the CID. The bridge awaits it before creating the product's core, whose execution kind it decides.
  primeChatCapability(label, async () => {
    const result =
      chainBackend === 'rpc-gateway'
        ? await (await loadRpcResolve()).resolveExecutableManifestViaRpc(label, 'worker')
        : await resolveExecutableManifestRemote(label, 'worker');
    return result.kind === 'ok' && result.value.kind === 'worker' && result.value.includes.chat === true;
  });

  const renderChunkPromise: Promise<RenderChunk> = loadBridge();
  void renderChunkPromise.catch(() => {
    /* fire-and-forget */
  });

  showProductPill(label, getActiveTldSuffix());

  listenForSandboxStatus();

  // One warm Bulletin chain serves every sandbox load. Blocks are kept here, since the credentialless sandbox loses
  // its storage on every reload.
  const blockCache = cacheSettings.skipArchiveCache
    ? undefined
    : { get: getCachedBlock, put: putCachedBlock, delete: deleteCachedBlock };
  const blocksServed = { cache: 0, network: 0 };
  listenForSandboxBitswap({
    ...(blockCache !== undefined ? { blockCache } : {}),
    onBlockServed: from => {
      blocksServed[from] += 1;
    },
  });
  if (blockCache !== undefined) {
    // Fires once per page load, on the first sandbox done.
    onSandboxDone(() => {
      const { cache: hits, network: misses } = blocksServed;
      if (hits + misses === 0) {
        return;
      }
      emitDotliDebugEvent({
        layer: 'boot',
        event: 'block_cache',
        flowId: bootFlowId,
        timestamp: Date.now(),
        payload: { hits, misses },
      });
      m.count(misses === 0 ? S.CACHE_HIT : S.CACHE_MISS, {
        surface: 'block_cache',
      });
      requestIdleCallback(() => {
        void pruneBlockCache(BLOCK_CACHE_MAX_BYTES);
      });
    });
  }

  const shieldState: ShieldState = isVerifiedSession(chainBackend) ? 'verified' : 'trusted';

  // Bands follow where load time goes: Asset Hub sync and the content fetch own most of the bar. Connecting takes no
  // time, so it shares the Syncing band.
  const PHASE_INDEX: Partial<Record<ResolvePhase, number>> = {
    'relay-chain-adding': 1,
    'asset-hub-connecting': 2,
    'asset-hub-syncing': 2,
    'asset-hub-ready': 2,
    'resolving-content': 3,
  };
  // Only direct mode relays bitswap through this window, so only it can report a download percentage.
  const countsContentBytes = chainBackend === 'smoldot-direct';
  // The visitor reads the stage's copy, not the label.
  const smoldotPhases = (startLabel: string): LoadingPhase[] => [
    {
      label: startLabel,
      base: 2,
      target: 6,
      expectedMs: 650,
      stage: 'starting',
    },
    {
      label: 'Adding relay chain',
      base: 6,
      target: 10,
      expectedMs: 120,
      stage: 'relay',
    },
    {
      label: 'Syncing Asset Hub',
      base: 10,
      target: 55,
      expectedMs: 6500,
      stage: 'assetHub',
    },
    {
      label: 'Resolving',
      base: 55,
      target: 62,
      expectedMs: 1200,
      stage: 'resolving',
    },
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
  if (chainBackend === 'smoldot-shared-worker') {
    initPhases(smoldotPhases('Starting Worker'));
  } else if (chainBackend === 'smoldot-direct') {
    initPhases(smoldotPhases('Starting'));
  } else {
    initPhases([
      {
        label: 'Connecting',
        base: 5,
        target: 50,
        expectedMs: 1200,
        stage: 'relay',
      },
      {
        label: 'Resolving',
        base: 50,
        target: 62,
        expectedMs: 1200,
        stage: 'resolving',
      },
      {
        label: 'Fetching content',
        base: 62,
        target: 95,
        expectedMs: 10000,
        stage: 'content',
        // No `reportsProgress`: the sandbox pulls the archive over HTTP, so nothing counts its bytes here.
      },
    ]);
  }
  // Always the last phase, entered just before handing off to the sandbox.
  const contentFetchPhase = chainBackend === 'rpc-gateway' ? 2 : 4;
  setLoadingDomain(label);
  advancePhase(0);

  // Subscribed outside the backend gate: a gateway trace with no chain events is the point, not a gap.
  const trace = startResolutionTrace({
    domain: withActiveTld(label),
    network: getNetwork(),
    backend: chainBackend,
    attempt,
    startedAt: T0,
  });
  // For the trace's `loading_phase` and the capture below.
  let step = 'resolve_setup';
  const enterStep = (next: string): void => {
    step = next;
    trace.step(next);
  };
  onProtocolChainSync(event => {
    trace.chainSync(event);
  });
  onProtocolChainDetail(event => {
    trace.chainDetail(event);
    if (event.dbCache !== undefined) {
      emitDotliDebugEvent({
        layer: 'chain',
        event: 'dbcache',
        flowId: bootFlowId,
        timestamp: Date.now(),
        payload: {
          chain: chainRoleForKey(event.chain),
          dbCache: event.dbCache,
        },
      });
    }
  });
  onProtocolNetBytes(({ received }) => {
    trace.bytes(received);
  });
  onContentProgress(({ bytesFetched, totalBytes }) => {
    trace.content(bytesFetched, totalBytes);
  });

  // Typed lifecycle milestones from the protocol iframe drive the bar in direct mode. The other backends forward
  // none, so `statusToPhase` reads their log text.
  if (chainBackend === 'smoldot-direct') {
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
            setLoadingWarning(pendingWarning);
          }
        }, waitLeft);
        return;
      }
      warningShown = true;
      trace.warningShown();
      pendingWarning = null;
      setLoadingWarning(message);
    };

    onProgressStall(() => {
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

    onProtocolChainSync(event => {
      const role = chainRoleForKey(event.chain);
      const phase = trackPhase(role, event.syncKind);
      if (event.syncKind === 'peers' && event.peers !== undefined) {
        // Independent of the phase, since the relay usually finds its peers after its last transition.
        const changed = peersByRole.get(role) !== event.peers;
        peersByRole.set(role, event.peers);
        if (changed) {
          emitDotliDebugEvent({
            layer: 'chain',
            event: 'peers',
            flowId: bootFlowId,
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
            log.event(`${event.chain} ${phase}`, {
              flow: 'chain',
              ...(peers === undefined ? {} : { peers }),
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            });
          }
          emitDotliDebugEvent({
            layer: 'chain',
            event: 'phase',
            flowId: bootFlowId,
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
          recordPeerCount(chainRoleForKey(event.chain), event.peers);
          if (isCriticalChain(event.chain)) {
            livePeers.set(event.chain, event.peers);
          }
          if (event.chain === 'bulletin') {
            if (event.peers > 0) {
              // With a peer the download can start, so the clock takes over: a cached archive never asks for a block.
              releasePhaseProgress();
            }
          }
          return;
        case 'warpSyncProgress': {
          // The one true percentage smoldot offers.
          const { at, target } = event;
          if (event.chain === 'relay' && at !== undefined && target !== undefined && target > 0 && at <= target) {
            nudgePhaseProgress(at / target, 'relay');
          }
          return;
        }
        case 'firstPeer':
          if (event.chain === 'asset-hub') {
            advancePhase(2);
          }
          return;
        case 'bootstrapComplete':
          if (event.chain === 'asset-hub') {
            advancePhase(3);
          }
          return;
        case 'warpSyncFinished':
          // The last sample lands short of the target, which would leave the band just below full.
          if (event.chain === 'relay') {
            nudgePhaseProgress(1, 'relay');
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
    const SPEED_WINDOW_MS = 3_000;
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
      emitDotliDebugEvent({
        layer: 'chain',
        event: 'bytes',
        flowId: bootFlowId,
        timestamp: at,
        payload: { received },
      });
    };
    window.addEventListener(
      'dotli:product-loaded',
      () => {
        if (bytesDebugOpen && chainBytes !== lastBytesDebugTotal) {
          emitBytesDebug(chainBytes, Date.now());
        }
        bytesDebugOpen = false;
      },
      { once: true },
    );
    onProtocolNetBytes(({ received }) => {
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
    onContentProgress(({ bytesFetched, totalBytes }) => {
      recordTransfer({ fetched: bytesFetched, total: totalBytes });
      if (totalBytes === null) {
        // No declared total, so no percentage: the clock takes the bar back.
        releasePhaseProgress();
      }
      if (totalBytes !== null && totalBytes > 0) {
        nudgePhaseProgress(bytesFetched / totalBytes, 'content');
        // The tail is the sandbox unpacking and painting. Only relayed blocks count, so this cannot fire early.
        if (bytesFetched >= totalBytes) {
          setLoadingStage('preparing');
        }
      }
    });
  }

  // Read in the catch below, so a warm-path failure is not counted against the cold path.
  let cidCache: CidCacheResult | 'unknown' = 'unknown';

  // "n/a" where no light client gates the render, keeping "unknown" for a signal that should have arrived.
  const smoldotDbCacheTags = (): Record<string, string> => {
    const inapplicable = cidCache === 'hit' || chainBackend === 'rpc-gateway';
    return {
      smoldotdb_relay_cache: inapplicable ? 'n/a' : getSmoldotDbOutcome('relay'),
      smoldotdb_hub_cache: inapplicable ? 'n/a' : getSmoldotDbOutcome('hub'),
      smoldotdb_bulletin_cache: inapplicable ? 'n/a' : getSmoldotDbOutcome('bulletin'),
    };
  };

  // The content fetch outlives the handoff, so the trace waits for the sandbox's report. Subscribed before the
  // handoff, since a cached archive can report before it returns.
  let resolveFailed = false;
  const settleOnContent = (): void => {
    onSandboxDone((outcome, failedStep) => {
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
  const handedOff = (): void => {
    trace.handedOff();
    enterStep('content');
  };

  try {
    enterStep('cid_cache_read');
    const cached = cacheSettings.skipCidCache ? null : await getCachedCid(label, getNetwork());
    const cachedCid = cached?.cid ?? null;
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'cid_cache_checked',
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        hit: cachedCid !== null,
        ...(cachedCid !== null ? { cid: cachedCid } : {}),
      },
    });
    cidCache = cachedCid !== null ? 'hit' : cacheSettings.skipCidCache ? 'skipped' : 'miss';
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
        requestIdleCallback(() => {
          void runBackgroundRevalidate(label, cached.cid, chainBackend, false);
        });
        throw err;
      }
      await m.span(S.E2E_FAST, async () => {
        setShieldState(shieldState);
        enterStep('render_chunk_load');
        const { renderAppSubdomain } = await renderChunkPromise;
        advancePhase(contentFetchPhase);
        enterStep('render_handoff');
        settleOnContent();
        await renderAppSubdomain(cached.cid, label);
      });
      forgetError();
      void recordRecentLabel(label);
      void applyProductBranding(label, cachedManifests).catch((err: unknown) => {
        resolveLog.warn(`[dot.li manifest] branding failed for ${withActiveTld(label)}:`, err);
      });
      performance.mark('dotli:main:end');
      log.event('Sandbox mounted', { flow: 'resolve', path: 'cache', total_ms: Math.round(performance.now() - T0) });
      emitDotliDebugEvent({
        layer: 'boot',
        event: 'ready',
        flowId: bootFlowId,
        timestamp: Date.now(),
        payload: {
          label,
          totalMs: performance.now() - T0,
          path: 'fast',
        },
      });
      handedOff();
      // Keeps the cache honest without blocking the render.
      requestIdleCallback(() => {
        void runBackgroundRevalidate(label, cached.cid, chainBackend, true);
      });
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
    const manifestsRead = readProductManifests(label, chainBackend);
    manifestsRead.catch(() => {
      /* Awaited below. A CID failure first must not leave this unhandled. */
    });
    enterStep('name_resolve');
    const resolveStart = performance.now();

    const resolveFlowId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `resolve-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
    const resolveSource: 'smoldot' | 'rpc-gateway' = chainBackend !== 'rpc-gateway' ? 'smoldot' : 'rpc-gateway';
    emitDotliDebugEvent({
      layer: 'resolve',
      event: 'started',
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: { label, source: resolveSource },
    });
    const emitPhase = (msg: string, phaseName: string): void => {
      emitDotliDebugEvent({
        layer: 'resolve',
        event: 'phase',
        flowId: resolveFlowId,
        timestamp: Date.now(),
        payload: { label, phase: phaseName, message: msg },
      });
    };

    // The app subname first, then the base label when the subname has no contenthash.
    let cid: string | null;
    log.event('Resolving name', { flow: 'resolve', name: withActiveTld(`app.${label}`), backend: chainBackend });
    if (chainBackend !== 'rpc-gateway') {
      const { statusToPhase } = await loadResolve();
      const onResolveProgress = (msg: string): void => {
        // The resolver owns the mapping from its status text to a phase.
        const phase = statusToPhase(msg);
        const mappedPhase = phase === null ? undefined : PHASE_INDEX[phase];
        if (mappedPhase !== undefined) {
          advancePhase(mappedPhase);
        }
        emitPhase(msg, phase ?? 'progress');
        // Developer-facing text, so it stays in the debug stream and never reaches the headline.
      };
      cid = await resolveDotNameRemote(`app.${label}`, onResolveProgress);
      if (cid === null) {
        log.event('App subname has no contenthash, trying the base name', { flow: 'resolve' });
        cid = await resolveDotNameRemote(label, onResolveProgress);
      }
    } else {
      const { resolveDotNameViaRpc } = await loadRpcResolve();
      const onResolveProgress = (msg: string): void => {
        emitPhase(msg, 'progress');
      };
      cid = await resolveDotNameViaRpc(`app.${label}`, onResolveProgress);
      if (cid === null) {
        log.event('App subname has no contenthash, trying the base name', { flow: 'resolve' });
        cid = await resolveDotNameViaRpc(label, onResolveProgress);
      }
    }

    emitDotliDebugEvent({
      layer: 'resolve',
      event: 'completed',
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        source: resolveSource,
        cid,
        durationMs: performance.now() - resolveStart,
      },
    });

    stopStatusTick();
    performance.mark('dotli:resolve:end');
    log.debug(
      `[dot.li resolve] RESOLVED ${withActiveTld(label)} via ${chainBackend} in ${dur(resolveStart)} (total ${elapsed(T0)}) -> ${cid ?? 'null'}`,
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

    if (!cacheSettings.skipCidCache) {
      requestIdleCallback(() => {
        void setCachedCid(label, getNetwork(), cid, toCache(manifests));
      });
    }

    setShieldState(shieldState);

    enterStep('render_chunk_load');
    const { renderAppSubdomain } = await renderChunkPromise;
    advancePhase(contentFetchPhase);
    enterStep('render_handoff');
    settleOnContent();
    await renderAppSubdomain(cid, label);
    forgetError();
    void recordRecentLabel(label);
    void applyProductBranding(label, manifests).catch((err: unknown) => {
      resolveLog.warn(`[dot.li manifest] branding failed for ${withActiveTld(label)}:`, err);
    });

    m.distribution(S.E2E_SLOW, performance.now() - coldStartMs, 'millisecond', {
      outcome: 'ok',
      chain_backend: chainBackend,
    });
    performance.mark('dotli:main:end');
    log.event('Sandbox mounted', { flow: 'resolve', path: 'cold', total_ms: Math.round(performance.now() - T0) });
    handedOff();
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'ready',
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        totalMs: performance.now() - T0,
        path: 'slow',
      },
    });
  } catch (err) {
    resolveFailed = true;
    performance.mark('dotli:main:end');
    // One verdict drives both the report and the error page, so `error_kind` counts exactly the screens shown.
    const error = describeError(err, chainBackend !== 'rpc-gateway');
    // Reported before rendering, in case rendering throws, and while the trace is still open, so the error lands in it.
    const dependency = chainBackend === 'rpc-gateway' ? 'asset-hub-rpc' : 'smoldot';
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
        chain_backend: chainBackend,
      },
    });
    trace.finish('error', {
      reason: err instanceof Error ? err.message : String(err),
      errorKind: error.kind,
    });
    log.debug(`[dot.li] Resolution failed via ${dependency}: ${serializeError(err)}`);
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'failed',
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        reason: err instanceof Error ? err.message : String(err),
        dependency,
      },
    });
    log.event('Error page shown', { flow: 'resolve', error_kind: error.kind, recovery: error.recovery });
    if (error.recovery === 'none') {
      showError(error.title, error.message, undefined, error.tips);
      return;
    }
    if (error.recovery === 'reload') {
      showError(
        error.title,
        error.message,
        {
          label: RELOAD_BTN_LABEL,
          icon: RELOAD_GLYPH,
          onClick: () => {
            markContinuation('reload_button');
            window.location.reload();
          },
        },
        error.tips,
      );
      return;
    }
    const nextBackend = chainBackend === 'rpc-gateway' ? 'smoldot-shared-worker' : 'rpc-gateway';
    const btnLabel = FAILOVER_BTN_LABELS[nextBackend];
    // A failed provider will fail again, while a failed light client is usually a transient peer problem.
    const failoverIsPrimary = chainBackend === 'rpc-gateway';
    // The reload comes up on a fresh light client instead of the one that lost its subscription.
    const reloadForRecovery = (): void => {
      if (error.resetProtocol === true) {
        try {
          sessionStorage.setItem('dotli:pending-reset:protocol', '1');
          // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode. The purge is best-effort while the reload below is unconditional.
        } catch {
          /* sessionStorage unavailable: reload without the purge */
        }
      }
      markContinuation('reload_button');
      window.location.reload();
    };
    const commitFailover = (): void => {
      log.event('Transport switched after failure', { flow: 'resolve', from: chainBackend, to: nextBackend });
      emitDotliDebugEvent({
        layer: 'failover',
        event: 'chain_backend',
        flowId:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `fail-${String(Date.now())}`,
        timestamp: Date.now(),
        payload: {
          from: chainBackend,
          to: nextBackend,
          reason: err instanceof Error ? err.message : 'resolution failed',
        },
      });
      switchBackendAndReload(nextBackend);
    };
    // Dropping to a trusted provider gives up verification, so the user confirms it and staying put is primary.
    const showFailoverWarning = (): void => {
      showErrorPage({
        glyph: 'warning',
        title: "Your connection won't be verified",
        detail: trustedProviderWarning(withActiveTld(label), trustedProviderHosts()),
        actions: [
          { label: TRY_ANYWAY_BTN_LABEL, onClick: commitFailover },
          {
            label: GO_BACK_BTN_LABEL,
            primary: true,
            onClick: showResolutionError,
          },
        ],
      });
    };
    // A first sighting points at Settings rather than offering a one-click drop to a trusted provider. A repeat of
    // the same failure earns the shortcut.
    const gateFailover = nextBackend === 'rpc-gateway' && !errorAlreadySeen(error.kind);
    function showResolutionError(): void {
      // Only the gated direction records a sighting. `unknown` never does, since two unrelated failures share it.
      if (nextBackend === 'rpc-gateway' && error.kind !== 'unknown') {
        rememberError(error.kind);
      }
      showErrorPage({
        title: error.title,
        detail: error.message,
        tips: error.tips,
        actions: [
          {
            label: RELOAD_BTN_LABEL,
            icon: RELOAD_GLYPH,
            primary: !failoverIsPrimary,
            onClick: reloadForRecovery,
          },
          gateFailover
            ? {
                label: OPEN_SETTINGS_BTN_LABEL,
                icon: SETTINGS_GLYPH,
                onClick: openSettings,
              }
            : {
                label: btnLabel,
                primary: failoverIsPrimary,
                onClick: nextBackend === 'rpc-gateway' ? showFailoverWarning : commitFailover,
              },
        ],
      });
    }
    showResolutionError();
  }
}

// Everything past boot catches its own failures, so this broke the shell before a load started.
main().catch(reportBootFailure);
