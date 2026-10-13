// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL and wires each route to the host's real sources and screens.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPwa } from './pwa.js';
import { boot, createBootFlowId, reportBootFailure, startHost, startPage, T0, type HostStartup } from './startup.js';
import { showErrorPage, showNotification } from '@dotli/ui';
import { showNoContentError } from './no-content-page.js';
import {
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
} from './loading-controller.js';
import { setVerificationShieldState, showLocalhostPill, showProductPill } from './state/url-pill.js';
import { armTopbarAutoHide, setProductContentShown } from './topbar-autohide.js';
import { schedulePendingReset } from './runtime/pending-reset.js';
import { productStore, setProductError } from './runtime/state/product.js';
import { loggedInStore } from './runtime/state/auth.js';
import { loadBridge } from './lazy.js';
import type { ProductFrame } from './runtime/product-frame.js';
import { bitswapGet, createSandboxBlockRelay } from '@dotli/bitswap';
import { loadVerify } from '@dotli/content';
import { reportExpected, spans as S } from '@dotli/metrics';
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
import { elapsed, log } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import {
  BLOCK_CACHE_MAX_BYTES,
  DEBUG,
  getActiveServicesConfig,
  isLocalhost,
  isSandboxOrigin,
  getNetwork,
  getTldSuffix,
  isSharedWorkerAvailable,
  localStorageAdapter,
  parseSettingsFromSearch,
  resolveSettings,
} from '@dotli/config';
import { startSandboxChannel, type SandboxChannel } from '@dotli/sandbox-wire';
import {
  emitDotliDebugEvent,
  enableDotliDebugBuffering,
  resolveDebugMode,
  watchDotliDebugEvents,
} from '@dotli/truapi-debug';
import { loadTruapiDebugMount } from '@dotli/truapi-debug-ui';
import { loadResolve } from '@dotli/resolver';
import { startResolutionTrace } from './resolution-trace.js';
import { beginAttempt, endJourney } from './journey.js';
import { startLoadProgress } from './load-progress.js';
import { startShellState } from './shell-state.js';
import { openSettings } from './settings-intent.js';
import { createProductLoader } from './product-loader.js';
import { readChatCapability } from './chat-capability.js';
import { startSandboxContent } from './sandbox-content.js';
import { startShieldAutoHide } from './shield-autohide.js';
import type { CacheRevalidationDeps } from './cache-revalidate.js';
import { revalidateCachedProduct } from './manifest-gate.js';
import { createNameSource, type RpcResolver } from './name-source.js';
import { loadCacheRevalidation, loadDebugPanelParts, loadFailureScreens, loadProductBranding } from './lazy.js';
import {
  reloadAfterFailure,
  sessionErrorSightings,
  showLoadFailure,
  switchBackendAndReload,
} from './show-load-failure.js';
import {
  leaveForLanding,
  localTargetPath,
  readLocalhostUrl,
  readShellRoute,
  runShell,
  type LocalTarget,
  type ShellServices,
} from './shell-route.js';
import { createBlockVerifier } from './block-verifier.js';
import { reportLazyMiss } from './lazy-miss.js';
import { debugPanelHost, startDebugPanel } from './debug-panel.js';
import { startMainThreadMonitor } from './main-thread-monitor.js';
import { listenForSandboxDebugEvents } from './sandbox-debug-events.js';
import { reportSandboxHandlerFailure } from './sandbox-handler.js';
import { pageNotifications } from './page-notifications.js';
import { recordRecentLabel } from './recent-labels.js';
import { recordChainPhase, recordPeerCount, recordTransfer } from './state/network-monitor.js';

interface Shell extends ShellServices {
  sandboxChannel: SandboxChannel;
  startup: HostStartup;
  productFrame: ProductFrame;
}

/** Built on the host pool's Asset Hub connection, since the resolver cannot import the pool. */
async function loadRpcResolver(): Promise<RpcResolver> {
  const [mod, bridge] = await Promise.all([loadResolve(), loadBridge()]);
  return mod.createDotnsResolver({
    assetHub: bridge.hostAssetHubProvider,
    dotns: getActiveServicesConfig().dotns,
    source: 'rpc-gateway',
  });
}

async function startShell(): Promise<Shell> {
  log.debug(`[dot.li perf] main() started (${elapsed(T0)})`);

  // The panel's heavy chunk loads only on opt-in. Otherwise the bus stays off and every emit returns early.
  const debugMode = resolveDebugMode(window, DEBUG);
  if (debugMode.enabled) {
    enableDotliDebugBuffering();
    void startDebugPanel({
      load: loadTruapiDebugMount,
      host: async () =>
        debugPanelHost(
          (await loadDebugPanelParts()).debugPanelParts,
          // As the sandbox relay serves blocks: from the block cache, else over bitswap.
          async cid => (await getCachedBlock(cid)) ?? bitswapGet(cid),
        ),
      options: { startCollapsed: !debugMode.explicit },
    });
  }

  // The only window listener for sandbox frames, so the origin rule is applied in one place.
  const sandboxChannel = startSandboxChannel({
    target: window,
    isTrustedOrigin: isSandboxOrigin,
    onUntrusted: (type, origin) => {
      log.warn(`[dot.li] Rejected ${type} from non-sandbox origin: ${origin}`);
    },
    report: reportSandboxHandlerFailure,
  });

  const bootFlowId = createBootFlowId();
  if (debugMode.enabled) {
    startMainThreadMonitor(bootFlowId, { emit: emitDotliDebugEvent, watch: watchDotliDebugEvents });
    listenForSandboxDebugEvents(sandboxChannel, emitDotliDebugEvent);
  }

  const startup = await startHost(bootFlowId, { emitDotliDebugEvent, startShellState });
  const productFrame = startup.bridgeModule.startProductFrame(sandboxChannel);
  return { emit: emitDotliDebugEvent, flowId: bootFlowId, sandboxChannel, startup, productFrame };
}

async function openLocalTarget(target: LocalTarget, shell: Shell): Promise<void> {
  const { bridgeModule } = shell.startup;
  // Only debug builds read a localhost route, so the compile-time flag drops its branches from release bundles.
  const proxied = DEBUG && target.kind === 'localhost';
  boot.step = proxied ? 'localhost_render' : 'preview_render';
  log.event(proxied ? 'Route: localhost proxy' : 'Route: preview', { flow: 'boot', host: target.host });
  bridgeModule.setPageProduct({ label: target.host, productId: target.productId });

  pageNotifications().init({ label: target.host });

  // Local products carry no worker manifest to read the chat flag from, so the debug paths enable chat
  // unconditionally for product testing.
  await shell.productFrame.render({
    mode: 'iframe',
    label: target.host,
    url: target.url,
    productId: target.productId,
    chat: Promise.resolve(true),
  });
  setProductContentShown(true);
  if (proxied) {
    // No dotNS name to verify, so the shield is settled as soon as the product shows.
    startShieldAutoHide({ loggedIn: loggedInStore, arm: armTopbarAutoHide }).settle();
  }
  history.replaceState(null, '', localTargetPath(target));
  performance.mark('dotli:main:end');
  if (proxied) {
    shell.emit({
      layer: 'boot',
      event: 'ready',
      flowId: shell.flowId,
      timestamp: Date.now(),
      payload: { label: null, totalMs: performance.now() - T0, path: 'localhost' },
    });
  }
}

async function openProduct(label: string, shell: Shell): Promise<void> {
  const { emit, flowId, sandboxChannel, productFrame } = shell;
  const { chainBackend, cacheSettings, bridgeModule } = shell.startup;
  const autoHide = startShieldAutoHide({ loggedIn: loggedInStore, arm: armTopbarAutoHide });

  boot.step = 'resolve_setup';

  listenForSandboxStatus(sandboxChannel);
  const blockCache = cacheSettings.skipArchiveCache
    ? null
    : { get: getCachedBlock, put: putCachedBlock, delete: deleteCachedBlock };
  const relay = createSandboxBlockRelay({
    channel: sandboxChannel,
    blocks: bitswapGet,
    cache: blockCache,
    verify: createBlockVerifier({
      load: loadVerify,
      report: (step, err) => {
        reportLazyMiss('content', step, err);
      },
    }),
  });
  startSandboxContent({
    relay,
    cached: blockCache !== null,
    onSandboxDone,
    prune: () => {
      void pruneBlockCache(BLOCK_CACHE_MAX_BYTES);
    },
    idle: callback => {
      requestIdleCallback(callback);
    },
    emit,
    flowId,
  });

  const names = createNameSource({
    backend: chainBackend,
    remote: {
      resolveDotName: resolveDotNameRemote,
      resolveRootManifest: resolveRootManifestRemote,
      resolveExecutableManifest: resolveExecutableManifestRemote,
    },
    loadRpc: loadRpcResolver,
  });
  const revalidation: CacheRevalidationDeps = {
    names,
    decide: revalidateCachedProduct,
    cache: {
      set: (cachedLabel, cid, manifests) => setCachedCid(cachedLabel, getNetwork(), cid, manifests),
      evict: evictCachedCid,
    },
    notify: showNotification,
    reload: () => {
      markContinuation('app_update');
      window.location.reload();
    },
  };

  const loader = createProductLoader({
    backend: chainBackend,
    skipCidCache: cacheSettings.skipCidCache,
    network: getNetwork,
    flowId,
    startedAt: T0,
    emit,
    frame: { setPageProduct: bridgeModule.setPageProduct, render: product => productFrame.render(product) },
    names,
    cidCache: {
      get: cachedLabel => getCachedCid(cachedLabel, getNetwork()),
      set: (cachedLabel, cid, manifests) => setCachedCid(cachedLabel, getNetwork(), cid, manifests),
    },
    journey: { begin: beginAttempt, end: endJourney },
    startTrace: startResolutionTrace,
    startProgress: ({ label: loadLabel, trace }) =>
      startLoadProgress({
        label: loadLabel,
        backend: chainBackend,
        flowId,
        events: {
          onChainSync: onProtocolChainSync,
          onChainDetail: onProtocolChainDetail,
          onNetBytes: onProtocolNetBytes,
          onContentProgress: listener => relay.onProgress(listener),
        },
        loading: {
          initPhases,
          setLoadingDomain,
          advancePhase,
          nudgePhaseProgress,
          releasePhaseProgress,
          setLoadingStage,
          setLoadingWarning,
          onProgressStall,
          stopStatusTick,
        },
        monitor: { recordChainPhase, recordPeerCount, recordTransfer },
        trace,
        emit,
        product: productStore,
      }),
    onContentDone: onSandboxDone,
    smoldotDbOutcome: getSmoldotDbOutcome,
    readChat: readChatCapability,
    scheduleNotifications: options => {
      pageNotifications().init(options);
    },
    revalidate: async (cachedLabel, servedCid, onScreen) => {
      const { revalidateCachedCopy } = await loadCacheRevalidation();
      await revalidateCachedCopy(cachedLabel, servedCid, onScreen, revalidation);
    },
    brand: async (brandedLabel, manifests) => {
      const { applyProductBranding } = await loadProductBranding();
      await applyProductBranding(brandedLabel, manifests, { fetchBlock: bitswapGet });
    },
    page: {
      showProductPill,
      settleShield: state => {
        setVerificationShieldState(state);
        autoHide.settle();
      },
      showNoContent: label => {
        showNoContentError(label);
      },
      setProductError,
      setContentShown: setProductContentShown,
      recordRecentLabel,
    },
    presentFailure: failure =>
      showLoadFailure(failure, {
        load: loadFailureScreens,
        showErrorPage,
        openSettings,
        reload: reloadAfterFailure,
        switchBackend: switchBackendAndReload,
        resetProtocolOnReload: () => {
          try {
            schedulePendingReset(['protocol']);
          } catch (err: unknown) {
            // No session storage, as in a private window, so the reload comes up on the chain database it had.
            reportExpected(err, {
              flow: 'resolve',
              step: 'pending_reset',
              metric: S.PENDING_RESET_SCHEDULE,
              reason: 'failure_screen',
              message: '[dot.li] protocol purge not stored before the reload:',
            });
          }
        },
        sightings: sessionErrorSightings,
        emit,
      }),
    forgetFailure: sessionErrorSightings.forget,
    idle: callback => {
      requestIdleCallback(callback);
    },
  });
  await loader.load(label);
}

async function main(): Promise<void> {
  startPage();
  await runShell({
    route: readShellRoute(window.location, {
      localhost: isLocalhost,
      framed: window.self !== window.top,
      // Behind the compile-time flag, so release bundles drop the localhost proxy.
      localhostProxy: DEBUG ? readLocalhostUrl : undefined,
    }),
    // The TLD is a guess until settings apply, from the link and this origin, and the product route sets it again.
    showProductPill: label => {
      const { network } = resolveSettings({
        local: localStorageAdapter,
        shared: null,
        url: parseSettingsFromSearch(new URLSearchParams(window.location.search)),
        sharedWorkerAvailable: isSharedWorkerAvailable(),
      });
      showProductPill(label, getTldSuffix(network));
    },
    showLocalhostPill,
    startShell,
    openLocalTarget,
    openProduct,
    leaveForLanding: () =>
      leaveForLanding({
        location: window.location,
        localhost: isLocalhost,
        workers: async () => ('serviceWorker' in navigator ? navigator.serviceWorker.getRegistrations() : []),
      }),
    deepPath: () => window.location.pathname + window.location.search,
  });
}

startPwa();

// Everything past boot catches its own failures, so this broke the shell before a load started.
main().catch(reportBootFailure);
