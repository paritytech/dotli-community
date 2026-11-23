// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Opens a product by its name in the shell: its content relay, its name source and its loader.

import { createSandboxBlockRelay, type SandboxBlockRelay } from '@dotli/bitswap';
import { getActiveServicesConfig } from '@dotli/config';
import { loadVerify } from '@dotli/content';
import { createReporter } from '@dotli/metrics';
import { getProtocolClient } from '@dotli/protocol';
import { loadResolve } from '@dotli/resolver';
import { blockCache as pageBlockCache, type CachedCid } from '@dotli/storage';
import { debugBus } from '@dotli/truapi-debug';
import { runWhenIdle } from '@dotli/ui';
import { createBlockVerifier } from '../features/productLoad/index.js';
import { bootTracker } from './createBootTracker.js';
import { recentLabels } from '../features/landing/index.js';
import { createLoadTelemetry } from '../features/productLoad/index.js';
import { pageLoading } from '../features/productLoad/index.js';
import { createNameSource, type RpcResolver } from '../features/productLoad/index.js';
import { createPageCidCache } from '../features/productLoad/index.js';
import { createProductAuthor } from '../features/productIdentity/index.js';
import { createProductLoader } from './createProductLoader.js';
import type { H160Address } from '../kit/h160Address.js';
import { updateReload } from '../kit/createUpdateReload.js';
import { loadFailureScreen } from '../features/productLoad/index.js';
import { pageNotifications } from '../features/notifications/index.js';
import { PAGE_START } from './pageStart.js';
import { reportLazyMiss } from '../kit/reportLazyMiss.js';
import { productState } from '../features/page/index.js';
import type { ShellRoute } from '../kit/shellRoute.js';
import type { Shell } from './startShell.js';
import type { PageProductWorkerParams } from '../features/productWorker/pageProductWorker.js';
import { startSandboxContent } from '../features/productLoad/index.js';
import { productCardState } from '../features/productIdentity/index.js';

const contentReport = createReporter({ flow: 'content' });
const workerReport = createReporter({ flow: 'product_worker' });

/** Idle work still runs this long after it was asked for, so a busy page cannot starve it. */
const IDLE_WORK_TIMEOUT_MS = 2_000;

/** Content block cache cap. After each load the least recently used blocks are dropped until it fits. */
const BLOCK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** A product route to open, with the CID cache read started early for its name, which never rejects. */
export type ProductToOpen = Extract<ShellRoute, { kind: 'product' }> & { cidRead: Promise<CachedCid | null> };

/** Opens the product `route` names. Rejects as its load does. */
export async function openProduct(route: ProductToOpen, shell: Shell): Promise<void> {
  bootTracker.setStep('resolve_setup');
  const { label, base, cidRead } = route;
  const { settings, bridge } = shell.startup;
  const protocol = getProtocolClient();

  pageNotifications().init();
  // The screen clears at the sandbox's first done. The page never stops hearing it, so the stop goes unused.
  shell.sandboxLoad.subscribeCleared(pageLoading.dismissLoading);
  const relay = startProductContent(shell, settings.cache.skipArchiveCache);
  const names = createNameSource({
    backend: settings.backend,
    remote: protocol.resolve,
    loadRpc: loadRpcResolver,
  });
  // The product's worker runs from its first done for the page's life, so the stops go unused.
  shell.sandboxLoad.subscribeCleared(() => {
    void startProductWorker({ label, names, bridge });
  });
  const author = createProductAuthor({
    readOwner: readLoadedOwner,
    readAccount: bridge.readOriginalAccount,
    readUsernames: bridge.readPeopleUsernames,
    readPrimaryName: names.readPrimaryName,
  });
  productCardState.setAuthorSource(() => author.load());
  const loader = createProductLoader({
    backend: settings.backend,
    skipCidCache: settings.cache.skipCidCache,
    report: createLoadTelemetry({
      backend: settings.backend,
      flowId: shell.flowId,
      startedAt: PAGE_START,
      blockRelay: relay,
    }).report,
    names,
    base,
    productFrame: shell.productFrame,
    bridge,
    sandboxLoad: shell.sandboxLoad,
    cidCache: createPageCidCache({ names, label, cidRead, runWhenIdle: runWhenPageIdle }),
    bitswap: bridge.hostBitswapClient,
    recents: recentLabels,
    failureScreen: loadFailureScreen,
    updateReload,
    onProtocolVersionMismatch: protocol.frame.subscribeVersionMismatch,
  });
  await loader.load(label);
}

/**
 * Starts the worker of the page's product once its chunk loads. A chunk that fails to load is reported, and no worker
 * runs.
 */
async function startProductWorker(params: PageProductWorkerParams): Promise<void> {
  const chunk = await import('../features/productWorker/pageProductWorker.js').catch((error: unknown) => {
    reportLazyMiss({ report: workerReport, step: 'product_worker_load', error });
    return null;
  });
  chunk?.startPageProductWorker(params);
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
  const [resolveModule, { hostBridge: bridge }] = await Promise.all([
    loadResolve(),
    import('../features/productRuntime/core/bridge.js'),
  ]);
  return resolveModule.createDotnsResolver({
    assetHub: bridge.getHostAssetHubProvider,
    dotns: getActiveServicesConfig().dotns,
    source: 'rpc-gateway',
  });
}
