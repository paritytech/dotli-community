// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Opens a product by its name in the shell: its content relay, its name source and its loader.

import { createSandboxBlockRelay, type SandboxBlockRelay } from '@dotli/bitswap';
import { getActiveServicesConfig } from '@dotli/config';
import { loadVerify } from '@dotli/content';
import { createReporter } from '@dotli/metrics';
import { getProtocolClient } from '@dotli/protocol';
import { loadResolve } from '@dotli/resolver';
import { blockCache as pageBlockCache } from '@dotli/storage';
import { debugBus } from '@dotli/truapi-debug';
import { runWhenIdle } from '@dotli/ui';
import { createBlockVerifier } from './createBlockVerifier.js';
import { bootTracker } from './createBootTracker.js';
import { recentLabels } from './createLazyRecentLabels.js';
import { createLoadTelemetry } from './createLoadTelemetry.js';
import { pageLoading } from './createLoadingController.js';
import { createNameSource, type RpcResolver } from './createNameSource.js';
import { createPageCidCache, type EarlyCidRead } from './createPageCidCache.js';
import { createProductAuthor } from './createProductAuthor.js';
import { createProductLoader } from './createProductLoader.js';
import type { H160Address } from './h160Address.js';
import { loadHostBridge } from './lazy.js';
import { loadFailureScreen } from './loadFailureScreen.js';
import { pageNotifications } from './pageNotifications.js';
import { PAGE_START } from './pageStart.js';
import { reportLazyMiss } from './reportLazyMiss.js';
import { productState } from './runtime/state/productState.js';
import type { ShellRoute } from './shellRoute.js';
import type { Shell } from './startShell.js';
import { startSandboxContent } from './startSandboxContent.js';
import { productCardState } from './state/productCardState.js';

const contentReport = createReporter({ flow: 'content' });

/** Idle work still runs this long after it was asked for, so a busy page cannot starve it. */
const IDLE_WORK_TIMEOUT_MS = 2_000;

/** Content block cache cap. After each load the least recently used blocks are dropped until it fits. */
const BLOCK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

type Params = {
  route: Extract<ShellRoute, { kind: 'product' }>;
  shell: Shell;
  cidRead: EarlyCidRead | null;
};

/** Opens the product `route` names. Rejects as its load does. */
export async function openProduct({ route, shell, cidRead }: Params): Promise<void> {
  bootTracker.setStep('resolve_setup');
  const { label, base } = route;
  const { settings, bridge } = shell.startup;
  const protocol = getProtocolClient();

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
    report: createLoadTelemetry({
      backend: settings.backend,
      skipCidCache: settings.cache.skipCidCache,
      flowId: shell.flowId,
      startedAt: PAGE_START,
      blockRelay: relay,
    }).report,
    names,
    base,
    productFrame: shell.productFrame,
    bridge,
    sandboxLoad: shell.sandboxLoad,
    cidCache: createPageCidCache({ names, cidRead, runWhenIdle: runWhenPageIdle }),
    bitswap: bridge.hostBitswapClient,
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
  // The screen clears at the sandbox's first done. The page never stops hearing it, so the stop goes unused.
  shell.sandboxLoad.subscribeCleared(pageLoading.dismissLoading);
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
    subscribeOutcomes: shell.sandboxLoad.subscribeOutcomes,
    prune() {
      void pageBlockCache.prune(BLOCK_CACHE_MAX_BYTES);
    },
    runWhenIdle: runWhenPageIdle,
    emit: debugBus.emit,
    flowId: shell.flowId,
  });
  return relay;
}

/** Built on the host pool's Asset Hub connection, since the resolver cannot import the pool. */
async function loadRpcResolver(): Promise<RpcResolver> {
  const [resolveModule, bridge] = await Promise.all([loadResolve(), loadHostBridge()]);
  return resolveModule.createDotnsResolver({
    assetHub: bridge.getHostAssetHubProvider,
    dotns: getActiveServicesConfig().dotns,
    source: 'rpc-gateway',
  });
}
