// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL, starts the host and opens what the route names.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPwa } from './pwa.js';
import { boot, reportBootFailure, startHost, startPage, T0, type HostStartup } from './startup.js';
import { listenForSandboxStatus, onSandboxDone } from './loading-controller.js';
import { showLocalhostPill, showProductPill } from './state/url-pill.js';
import { armTopbarAutoHide, setProductContentShown } from './topbar-autohide.js';
import { loggedInStore } from './runtime/state/auth.js';
import { loadBridge, loadDebugPanelHost } from './lazy.js';
import type { ProductFrame } from './runtime/product-frame.js';
import { bitswapGet, createSandboxBlockRelay, type SandboxBlockRelay } from '@dotli/bitswap';
import { loadVerify } from '@dotli/content';
import { protocolClient } from '@dotli/protocol';
import {
  deleteCachedBlock,
  evictCachedCid,
  getCachedBlock,
  getCachedCid,
  pruneBlockCache,
  putCachedBlock,
  setCachedCid,
  type CachedManifests,
} from '@dotli/storage';
import { runWhenIdle, showNotification } from '@dotli/ui';
import { elapsed, log, randomId } from '@dotli/shared';
import {
  DEBUG,
  getActiveServicesConfig,
  getActiveTldSuffix,
  getNetwork,
  isLocalhost,
  isSandboxOrigin,
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
import { startShellState } from './shell-state.js';
import { createProductLoader, type LoaderCidCache } from './product-loader.js';
import { startSandboxContent } from './sandbox-content.js';
import { startShieldAutoHide } from './shield-autohide.js';
import { createNameSource, type NameSource, type RpcResolver } from './name-source.js';
import { revalidateCachedCopy } from './cache-revalidate.js';
import { markContinuation } from './continuation.js';
import { loadFailureScreen } from './load-failure-page.js';
import {
  leaveForLanding,
  localTargetPath,
  readLocalhostUrl,
  readShellRoute,
  type LocalTarget,
  type ShellRoute,
} from './shell-route.js';
import { createBlockVerifier } from './block-verifier.js';
import { reportLazyMiss } from './lazy-miss.js';
import { startDebugPanel } from './debug-panel.js';
import { startMainThreadMonitor } from './main-thread-monitor.js';
import { listenForSandboxDebugEvents } from './sandbox-debug-events.js';
import { reportSandboxHandlerFailure } from './sandbox-handler.js';
import { pageNotifications } from './page-notifications.js';
import { recordRecentLabel } from './recent-labels.js';
import { bindTopbar } from './topbar.js';
import { bindUrlPill } from './url-pill.js';

/** Idle work still runs this long after it was asked for, so a busy page cannot starve it. */
const IDLE_WORK_TIMEOUT_MS = 2_000;

/** Content block cache cap. After each load the least recently used blocks are dropped until it fits. */
const BLOCK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** What every route opens on once the host is up. */
interface Shell {
  /** The debug panel's flow for this page load, and the Sentry trace's id. */
  flowId: string;
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

/** Starts the debug tools, the sandbox channel, the settings and the bridge. */
async function startShell(route: ShellRoute): Promise<Shell> {
  log.debug(`[dot.li perf] main() started (${elapsed(T0)})`);

  // The panel's heavy chunk loads only on opt-in. Otherwise the bus stays off and every emit returns early.
  const debugMode = resolveDebugMode(window, DEBUG);
  if (debugMode.enabled) {
    enableDotliDebugBuffering();
    // The describer reports its own failed load, and the boot reports the bridge's.
    void loadBridge()
      .then(bridge => bridge.preloadWireDescriber())
      .catch(() => undefined);
    void startDebugPanel({
      load: loadTruapiDebugMount,
      host: async () => (await loadDebugPanelHost()).debugPanelHost,
      startCollapsed: !debugMode.explicit,
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

  const flowId = randomId();
  if (debugMode.enabled) {
    startMainThreadMonitor(flowId, { emit: emitDotliDebugEvent, watch: watchDotliDebugEvents });
    listenForSandboxDebugEvents(sandboxChannel, emitDotliDebugEvent);
  }

  const startup = await startHost(flowId, {
    emitDotliDebugEvent,
    startShellState: () => {
      startShellState();
      // Drawn from this origin's settings and the link's, set just before and with no await since, so the URL bar
      // paints with the page. The product's load draws it again once the shared store has answered.
      if (route.kind === 'product') {
        showProductPill(route.label, getActiveTldSuffix());
      }
    },
  });
  const productFrame = startup.bridgeModule.startProductFrame(sandboxChannel);
  return { flowId, sandboxChannel, startup, productFrame };
}

/** Tells the debug panel which route the page took, with the path as the settings left it. */
function announceRoute(route: Exclude<ShellRoute, { kind: 'nested' }>, flowId: string): void {
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'url_parsed',
    flowId,
    timestamp: Date.now(),
    payload: {
      label: route.kind === 'product' ? route.label : null,
      localhostHost: route.kind === 'localhost' ? route.host : null,
      deepPath: window.location.pathname + window.location.search,
    },
  });
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
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'ready',
      flowId: shell.flowId,
      timestamp: Date.now(),
      payload: { label: null, totalMs: performance.now() - T0, path: 'localhost' },
    });
  }
}

async function openProduct({ label, base }: Extract<ShellRoute, { kind: 'product' }>, shell: Shell): Promise<void> {
  const { settings, bridgeModule } = shell.startup;
  const protocol = protocolClient();
  boot.step = 'resolve_setup';

  pageNotifications().init({ label });
  const relay = startProductContent(shell, settings.cache.skipArchiveCache);
  const names = createNameSource({
    backend: settings.backend,
    remote: {
      resolveDotName: protocol.resolveDotNameRemote,
      resolveRootManifest: protocol.resolveRootManifestRemote,
      resolveExecutableManifest: protocol.resolveExecutableManifestRemote,
    },
    loadRpc: loadRpcResolver,
  });
  const loader = createProductLoader({
    backend: settings.backend,
    skipCidCache: settings.cache.skipCidCache,
    flowId: shell.flowId,
    startedAt: T0,
    names,
    base,
    frame: {
      setPageProduct: bridgeModule.setPageProduct,
      render: product => shell.productFrame.render(product),
      onContentDone: onSandboxDone,
      onContentProgress: listener => relay.onProgress(listener),
    },
    cidCache: pageCidCache(names),
    recents: { record: recordRecentLabel },
    failureScreen: loadFailureScreen,
  });
  await loader.load(label);
}

/**
 * The page's CID cache for the active network, checked with `names`, the source the load itself reads. Its writes and
 * its check against the network wait until the page is idle, so they never hold a render back.
 */
function pageCidCache(names: NameSource): LoaderCidCache {
  const set = (label: string, cid: string, manifests: CachedManifests): Promise<void> =>
    setCachedCid(label, getNetwork(), cid, manifests);
  return {
    get: label => getCachedCid(label, getNetwork()),
    storeLater: (label, cid, manifests) => {
      runWhenIdle(() => {
        void set(label, cid, manifests);
      }, IDLE_WORK_TIMEOUT_MS);
    },
    revalidateLater: (label, servedCid, onScreen) => {
      runWhenIdle(() => {
        void revalidateCachedCopy(label, servedCid, onScreen, {
          names,
          cache: { set, evict: evictCachedCid },
          notify: showNotification,
          reload: () => {
            markContinuation('app_update');
            window.location.reload();
          },
        });
      }, IDLE_WORK_TIMEOUT_MS);
    },
  };
}

/** Relays the sandbox's blocks through this window, from the block cache while it is on, and counts where they came from. */
function startProductContent(shell: Shell, skipArchiveCache: boolean): SandboxBlockRelay {
  listenForSandboxStatus(shell.sandboxChannel);
  const blockCache = skipArchiveCache ? null : { get: getCachedBlock, put: putCachedBlock, delete: deleteCachedBlock };
  const relay = createSandboxBlockRelay({
    channel: shell.sandboxChannel,
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
      runWhenIdle(callback, IDLE_WORK_TIMEOUT_MS);
    },
    emit: emitDotliDebugEvent,
    flowId: shell.flowId,
  });
  return relay;
}

async function main(): Promise<void> {
  startPage();
  const route = readShellRoute(window.location, {
    localhost: isLocalhost,
    framed: window.self !== window.top,
    // Behind the compile-time flag, so release bundles drop the localhost proxy.
    localhostProxy: DEBUG ? readLocalhostUrl : undefined,
  });
  // A nested dot.li would draw a second topbar.
  if (route.kind === 'nested') {
    return;
  }
  performance.mark('dotli:main:start');
  // From the URL alone, before any await, so the URL bar paints with the page.
  if (route.kind === 'preview' || route.kind === 'localhost') {
    showLocalhostPill(route.host);
  }
  const shell = await startShell(route);
  switch (route.kind) {
    case 'preview':
      await openLocalTarget(route, shell);
      return;
    case 'localhost':
      announceRoute(route, shell.flowId);
      await openLocalTarget(route, shell);
      return;
    case 'product':
      announceRoute(route, shell.flowId);
      await openProduct(route, shell);
      return;
    case 'landing':
      announceRoute(route, shell.flowId);
      await leaveForLanding({
        location: window.location,
        localhost: isLocalhost,
        workers: async () => ('serviceWorker' in navigator ? navigator.serviceWorker.getRegistrations() : []),
      });
      return;
  }
}

// The shell's chrome is static markup that only this page renders, so its bindings run from this one script.
const topbarElement = document.getElementById('topbar');
if (topbarElement !== null) {
  bindTopbar(topbarElement);
}
const urlPillElement = document.getElementById('topbar-url');
if (urlPillElement !== null) {
  bindUrlPill(urlPillElement);
}

startPwa();

// Everything past boot catches its own failures, so this broke the shell before a load started.
main().catch(reportBootFailure);
