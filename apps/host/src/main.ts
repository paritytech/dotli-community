// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL, starts the host and opens what the route names.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPage } from './startPage.js';
import { startHost, type HostStartup } from './startHost.js';
import { reportBootFailure } from './reportBootFailure.js';
// Right after the startup modules, so the page's start is marked once boot's dependencies have loaded.
import { PAGE_START } from './pageStart.js';
import { bootTracker } from './createBootTracker.js';
import { pageLoading } from './createLoadingController.js';
import { holdNetworkWhileLoading } from './holdNetworkWhileLoading.js';
import { loadingState } from './state/loadingState.js';
import { networkPause } from './runtime/createNetworkPause.js';
import { urlPillState } from './state/urlPillState.js';
import { productCardState } from './state/productCardState.js';
import { createProductAuthor } from './createProductAuthor.js';
import { pageTopbarAutoHide } from './createTopbarAutoHide.js';
import { productState } from './runtime/state/productState.js';
import { authState } from './runtime/state/authState.js';
import { loadHostBridge, loadDebugPanelHost } from './lazy.js';
import type { ProductFrame } from './runtime/createProductFrame.js';
import { createSandboxBlockRelay, type SandboxBlockRelay } from '@dotli/bitswap';
import { loadVerify } from '@dotli/content';
import { getProtocolClient } from '@dotli/protocol';
import { blockCache as pageBlockCache, cidCache } from '@dotli/storage';
import { runWhenIdle } from '@dotli/ui';
import { formatElapsed, log, markHandled, createRandomId } from '@dotli/shared';
import {
  DEBUG,
  getActiveServicesConfig,
  getActiveTldSuffix,
  getNetwork,
  isLocalhost,
  isSandboxOrigin,
  LOCAL_ROOT,
} from '@dotli/config';
import { startSandboxChannel, type SandboxChannel } from '@dotli/sandbox-wire';
import { debugBus, resolveDebugMode } from '@dotli/truapi-debug';
import { loadTruapiDebugMount } from '@dotli/truapi-debug-ui';
import { loadResolve } from '@dotli/resolver';
import { createReporter } from '@dotli/metrics';
import { startShellState } from './startShellState.js';
import { createProductLoader } from './createProductLoader.js';
import { createPageCidCache, type EarlyCidRead } from './createPageCidCache.js';
import { startSandboxContent } from './startSandboxContent.js';
import { watchSandboxLoad, type SandboxLoad } from './watchSandboxLoad.js';
import { startShieldAutoHide } from './startShieldAutoHide.js';
import { createNameSource, type RpcResolver } from './createNameSource.js';
import type { H160Address } from './h160Address.js';
import { loadFailureScreen } from './loadFailureScreen.js';
import {
  getLocalTargetPath,
  leaveForLanding,
  readLocalhostUrl,
  readShellRoute,
  type LocalTarget,
  type ShellRoute,
} from './shellRoute.js';
import { createBlockVerifier } from './createBlockVerifier.js';
import { getShellPageRole, type PageRole } from './runtime/pageRole.js';
import { reportLazyMiss } from './reportLazyMiss.js';
import { startDebugPanel } from './startDebugPanel.js';
import { startMainThreadMonitor } from './startMainThreadMonitor.js';
import { listenForSandboxDebugEvents } from './listenForSandboxDebugEvents.js';
import { reportSandboxHandlerFailure } from './reportSandboxHandlerFailure.js';
import { pageNotifications } from './pageNotifications.js';
import { recentLabels } from './createLazyRecentLabels.js';
import { bindTopbar } from './bindTopbar.js';
import { bindUrlPill } from './bindUrlPill.js';

const bootReport = createReporter({ flow: 'boot' });
const contentReport = createReporter({ flow: 'content' });

/** Idle work still runs this long after it was asked for, so a busy page cannot starve it. */
const IDLE_WORK_TIMEOUT_MS = 2_000;

/** Content block cache cap. After each load the least recently used blocks are dropped until it fits. */
const BLOCK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** What every route opens on once the host is up. */
type Shell = {
  /** The debug panel's flow for this page load, and the Sentry trace's id. */
  flowId: string;
  sandboxChannel: SandboxChannel;
  /** What the sandbox said about the page's load. */
  sandboxLoad: SandboxLoad;
  startup: HostStartup;
  productFrame: ProductFrame;
};

type OpenProductParams = {
  route: Extract<ShellRoute, { kind: 'product' }>;
  shell: Shell;
  cidRead: EarlyCidRead | null;
};

/** Built on the host pool's Asset Hub connection, since the resolver cannot import the pool. */
async function loadRpcResolver(): Promise<RpcResolver> {
  const [resolveModule, bridge] = await Promise.all([loadResolve(), loadHostBridge()]);
  return resolveModule.createDotnsResolver({
    assetHub: bridge.getHostAssetHubProvider,
    dotns: getActiveServicesConfig().dotns,
    source: 'rpc-gateway',
  });
}

/**
 * Starts the debug tools, the sandbox channel, the settings and the bridge. It sets the page's network before its
 * first await, and the shared settings read after that never change it.
 */
async function startShell(route: ShellRoute, role: PageRole): Promise<Shell> {
  log.debug(`[dot.li perf] main() started (${formatElapsed(PAGE_START)})`);

  // The panel's heavy chunk loads only on opt-in. Otherwise the bus stays off and every emit returns early.
  const debugMode = resolveDebugMode(window, DEBUG);
  if (debugMode.enabled) {
    debugBus.enableBuffering();
    // The describer reports its own failed load, and the boot reports the bridge's.
    void markHandled(loadHostBridge().then(bridge => bridge.wireDescriber.preload()));
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
    onUntrusted(type, origin) {
      log.warn(`[dot.li] Rejected ${type} from non-sandbox origin: ${origin}`);
    },
    report: reportSandboxHandlerFailure,
  });
  // The page never stops watching its sandbox's load early, so the watch's `dispose` goes unused.
  const sandboxLoad = watchSandboxLoad(sandboxChannel);

  const flowId = createRandomId();
  if (debugMode.enabled) {
    // The page never stops the monitor or the sandbox's debug events early, so their cleanups go unused.
    startMainThreadMonitor({ flowId, emit: debugBus.emit, watch: debugBus.watch });
    listenForSandboxDebugEvents(sandboxChannel, debugBus.emit);
  }

  const startup = await startHost({
    bootFlowId: flowId,
    role,
    emitDotliDebugEvent: debugBus.emit,
    startShellState() {
      startShellState();
      // Drawn from this origin's settings and the link's, set just before and with no await since, so the URL bar
      // paints with the page. The product's load draws it again once the shared store has answered.
      if (route.kind === 'product') {
        urlPillState.showProduct(route.label, getActiveTldSuffix());
      }
    },
  });
  const productFrame = startup.bridge.startProductFrame(sandboxChannel);
  return { flowId, sandboxChannel, sandboxLoad, startup, productFrame };
}

/** Tells the debug panel which route the page took, with the path as the settings left it. */
function announceRoute(route: Exclude<ShellRoute, { kind: 'nested' }>, flowId: string): void {
  debugBus.emit({
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
  const { bridge } = shell.startup;
  // Only debug builds read a localhost route, so the compile-time flag drops its branches from release bundles.
  const proxied = DEBUG && target.kind === 'localhost';
  bootTracker.setStep(proxied ? 'localhost_render' : 'preview_render');
  bootReport.log.event(proxied ? 'Route: localhost proxy' : 'Route: preview', { host: target.host });
  bridge.setPageProduct({ label: target.host, productId: target.productId });

  pageNotifications().init({ label: target.host });

  // Local products carry no worker manifest to read the chat flag from, so the debug paths enable chat
  // unconditionally for product testing.
  try {
    await shell.productFrame.render({
      mode: 'iframe',
      label: target.host,
      url: target.url,
      productId: target.productId,
      chat: Promise.resolve(true),
    });
  } catch (error: unknown) {
    // The boot's failure screen takes over, so the frame must not show the product again on a replacement core.
    shell.productFrame.halt();
    throw error;
  }
  pageTopbarAutoHide.setContentShown(true);
  // No dotNS name to verify, so the shield is settled as soon as the product shows. The bar folds for the page's life,
  // so the cleanup goes unused.
  startShieldAutoHide({ loggedIn: authState.loggedInStore, arm: pageTopbarAutoHide.arm }).settle();
  history.replaceState(null, '', getLocalTargetPath(target));
  performance.mark('dotli:main:end');
  if (proxied) {
    debugBus.emit({
      layer: 'boot',
      event: 'ready',
      flowId: shell.flowId,
      timestamp: Date.now(),
      payload: { label: null, totalMs: performance.now() - PAGE_START, path: 'localhost' },
    });
  }
}

async function openProduct({ route, shell, cidRead }: OpenProductParams): Promise<void> {
  const { label, base } = route;
  const { settings, bridge } = shell.startup;
  const protocol = getProtocolClient();
  bootTracker.setStep('resolve_setup');

  pageNotifications().init({ label });
  const relay = startProductContent(shell, settings.cache.skipArchiveCache);
  const names = createNameSource({
    backend: settings.backend,
    remote: {
      resolveDotName: protocol.resolve.resolveDotName,
      resolveOwner: protocol.resolve.resolveOwner,
      resolveRootManifest: protocol.resolve.resolveRootManifest,
      resolveExecutableManifest: protocol.resolve.resolveExecutableManifest,
    },
    loadRpc: loadRpcResolver,
  });
  const author = createProductAuthor({
    readOwner: readLoadedOwner,
    readAccount: address => bridge.readOriginalAccount(address),
    readUsernames: account => bridge.readPeopleUsernames(account),
  });
  productCardState.setAuthorSource(() => author.load());
  const loader = createProductLoader({
    backend: settings.backend,
    skipCidCache: settings.cache.skipCidCache,
    flowId: shell.flowId,
    startedAt: PAGE_START,
    names,
    base,
    ports: {
      product: shell.productFrame,
      core: bridge,
      sandbox: shell.sandboxLoad,
      content: relay,
    },
    cidCache: createPageCidCache({ names, cidRead, runWhenIdle: runWhenPageIdle }),
    fetchBlock: (cid, signal) => bridge.hostBitswapClient.get(cid, signal),
    recents: { record: recentLabels.record },
    failureScreen: loadFailureScreen,
    onProtocolVersionMismatch: protocol.frame.subscribeVersionMismatch,
  });
  await loader.load(label);
}

/** The loaded product's owner, null while no product is loaded or when its owner is not known. */
function readLoadedOwner(): H160Address | null {
  const product = productState.store.get();
  return product.status === 'loaded' ? (product.facts.owner ?? null) : null;
}

/** Runs `callback` once the page is idle, or after the page's idle timeout. */
function runWhenPageIdle(callback: () => void): void {
  runWhenIdle(callback, IDLE_WORK_TIMEOUT_MS);
}

/** Relays the sandbox's blocks through this window, from the block cache while it is on, and counts where they came from. */
function startProductContent(shell: Shell, skipArchiveCache: boolean): SandboxBlockRelay {
  // The screen clears at the sandbox's first done.
  void shell.sandboxLoad.cleared.then(pageLoading.dismissLoading).catch(contentReport.listener('page_loading.dismiss'));
  const blockCache = skipArchiveCache
    ? null
    : { get: pageBlockCache.get, put: pageBlockCache.put, delete: pageBlockCache.remove };
  const relay = createSandboxBlockRelay({
    channel: shell.sandboxChannel,
    blocks: (cid, signal) => shell.startup.bridge.hostBitswapClient.get(cid, signal),
    cache: blockCache,
    verify: createBlockVerifier({
      load: loadVerify,
      report(step, error) {
        reportLazyMiss({ report: contentReport, step, error });
      },
    }),
  });
  startSandboxContent({
    relay,
    cached: blockCache !== null,
    outcome: shell.sandboxLoad.outcome,
    prune() {
      void pageBlockCache.prune(BLOCK_CACHE_MAX_BYTES);
    },
    runWhenIdle: runWhenPageIdle,
    emit: debugBus.emit,
    flowId: shell.flowId,
  });
  return relay;
}

async function main(): Promise<void> {
  startPage();
  const framed = window.self !== window.top;
  const route = readShellRoute(window.location, {
    localhost: isLocalhost,
    framed,
    // Behind the compile-time flag, so release bundles drop the localhost proxy.
    readLocalhostProxyUrl: DEBUG ? readLocalhostUrl : undefined,
  });
  // A nested dot.li would draw a second topbar.
  if (route.kind === 'nested') {
    return;
  }
  performance.mark('dotli:main:start');
  // The load ends the hold itself once the loading screen is gone, so the stop goes unused.
  holdNetworkWhileLoading({ pause: networkPause, loading: loadingState.store });
  // From the URL alone, before any await, so the URL bar paints with the page.
  if (route.kind === 'preview' || route.kind === 'localhost') {
    urlPillState.showLocalhost(route.host);
  }
  const booting = startShell(route, getShellPageRole(route, framed));
  // The network is final once the shell boot has started. `cidCache.get` never rejects, so the read needs no handler
  // even when the shell fails to start.
  const cidRead: EarlyCidRead | null =
    route.kind === 'product' ? { label: route.label, read: cidCache.get(route.label, getNetwork()) } : null;
  const shell = await booting;
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
      await openProduct({ route, shell, cidRead });
      return;
    case 'landing':
      announceRoute(route, shell.flowId);
      leaveForLanding({ location: window.location, localRoot: LOCAL_ROOT });
      return;
  }
}

// The shell's chrome is static markup that only this page renders, so its bindings run from this one script. They
// last the page's life, so their cleanups go unused.
const topbarElement = document.getElementById('topbar');
if (topbarElement !== null) {
  bindTopbar(topbarElement);
}
const urlPillElement = document.getElementById('topbar-url');
if (urlPillElement !== null) {
  bindUrlPill(urlPillElement);
}

// Everything past boot catches its own failures, so this broke the shell before a load started.
main().catch(reportBootFailure);
