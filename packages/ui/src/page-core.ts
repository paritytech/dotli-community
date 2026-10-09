// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one refcounted TrUAPI core, under its product's label. The core goes with its last lease,
// and a faulted one is never handed out again.

import type { ProductExecutionKind, TrUApiProductProvider } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { log } from '@dotli/shared';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { loadLocalWalletCore } from './lazy.js';
import { createHostCallbacks } from './host-callbacks/handlers.js';
import { onStoredSessionChanged } from './host-callbacks/SessionStore.js';
import { createTruapiRuntimeConfig, labelToProductId } from './runtime-config.js';
import { readWalletBoot } from './wallet-boot.js';

export interface PageProduct {
  label: string;
  /** Overrides the label-derived product id, for the local debug routes. */
  productId?: string | undefined;
  /** How pairing presents itself, when not as the product. */
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
}

/** Close it through `close`, never the provider, or the core is marked faulted. */
export interface CoreConnection {
  provider: TrUApiProductProvider;
  productId: string;
  close(): void;
}

export interface CoreLease {
  runtime: WorkerPairingHostRuntime;
  connect(executionKind?: ProductExecutionKind): Promise<CoreConnection>;
  /** Idempotent. */
  release(): void;
}

interface Core {
  product: PageProduct;
  runtime: Promise<WorkerPairingHostRuntime>;
  leases: number;
  faulted: boolean;
  dispose(): void;
}

const LANDING_PRODUCT: PageProduct = {
  label: 'dotli',
  pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
};

let modalCoordinator: BlockingModalCoordinator | null = null;
let pageProduct: PageProduct = LANDING_PRODUCT;
let current: Core | null = null;
// Also holds cores a product change or fault replaced while they still had leases.
const cores = new Set<Core>();

export function initPageCore(coordinator: BlockingModalCoordinator): void {
  modalCoordinator = coordinator;
}

/** Called as soon as the page knows it, so a core booted by an early login is already the product's. */
export function setPageProduct(product: PageProduct): void {
  pageProduct = product;
}

function productIdOf(product: PageProduct): string {
  return product.productId ?? labelToProductId(product.label);
}

function isPageProduct(core: Core): boolean {
  return core.product.label === pageProduct.label && productIdOf(core.product) === productIdOf(pageProduct);
}

export async function acquireCore(): Promise<CoreLease> {
  if (current === null || current.faulted || !isPageProduct(current)) {
    current = createCore(pageProduct);
  }
  const core = current;
  core.leases++;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    core.leases--;
    if (core.leases === 0) {
      core.dispose();
    }
  };
  let runtime: WorkerPairingHostRuntime;
  try {
    runtime = await core.runtime;
  } catch (error) {
    release();
    throw error;
  }
  return {
    runtime,
    connect: executionKind => connect(core, runtime, executionKind),
    release,
  };
}

export function cancelPairing(): void {
  for (const core of cores) {
    core.runtime.then(
      runtime => {
        runtime.cancelPairing();
      },
      () => {
        // A core that never booted has no pairing to cancel.
      },
    );
  }
}

function createCore(product: PageProduct): Core {
  if (modalCoordinator === null) {
    throw new Error('TrUAPI page core used before initPageCore');
  }
  log.event('wallet core create', { flow: 'wallet', landing: product === LANDING_PRODUCT });
  const blockingModalScope = modalCoordinator.createScope();
  const { productId: _productId, ...hostConfig } = createTruapiRuntimeConfig(product.label, product.productId);
  let unsubscribeStore: (() => void) | null = null;
  const callbacks = createHostCallbacks({
    label: product.label,
    pairingLabel: product.pairing?.label,
    pairingDotSuffix: product.pairing?.dotSuffix,
    pairingHostGlobal: product.pairing?.hostGlobal,
    blockingModalScope,
  });
  // The wallet read and the host chunk load in parallel, so a Polkadot App boot waits on whichever is slower.
  const runtime = Promise.all([readWalletBoot(), import('@parity/truapi-host/web')]).then(
    async ([wallet, { createWebWorkerPairingHostRuntime }]) => {
      if (wallet !== null) {
        const { bootLocalWalletCore } = await loadLocalWalletCore();
        const booted = await bootLocalWalletCore(createWebWorkerPairingHostRuntime, callbacks, hostConfig, wallet, () =>
          cores.has(core),
        );
        log.event('wallet core booted', { flow: 'wallet', local: true });
        return booted;
      }
      const { default: HostWorker } = await import('@parity/truapi-host/worker-runtime?worker');
      const booted = await createWebWorkerPairingHostRuntime(new HostWorker(), callbacks, { hostConfig });
      log.event('wallet core booted', { flow: 'wallet' });
      // Other tabs' logins land in the shared session store. Once now too, for a session stored before boot.
      unsubscribeStore = onStoredSessionChanged(() => {
        booted.notifySessionStoreChanged();
      });
      queueMicrotask(() => {
        if (cores.has(core)) {
          booted.notifySessionStoreChanged();
        }
      });
      return booted;
    },
  );
  const core: Core = {
    product,
    runtime,
    leases: 0,
    faulted: false,
    dispose() {
      if (!cores.delete(core)) {
        return;
      }
      if (current === core) {
        current = null;
      }
      log.event('wallet core disposed', { flow: 'wallet', faulted: core.faulted });
      unsubscribeStore?.();
      blockingModalScope.dispose();
      runtime.then(
        booted => {
          booted.dispose();
        },
        () => {
          // Nothing booted, nothing to dispose.
        },
      );
    },
  };
  cores.add(core);
  runtime.catch((error: unknown) => {
    log.warn('[dot.li page-core] wallet core failed to boot:', error);
    core.faulted = true;
  });
  return core;
}

async function connect(
  core: Core,
  runtime: WorkerPairingHostRuntime,
  executionKind: ProductExecutionKind = 'App',
): Promise<CoreConnection> {
  const productId = productIdOf(core.product);
  let provider: TrUApiProductProvider;
  try {
    provider = await runtime.createProvider({ productId, executionKind });
  } catch (error) {
    log.warn('[dot.li page-core] wallet core refused a connection:', error);
    core.faulted = true;
    throw error;
  }
  let closing = false;
  // A deliberate close also fires close listeners. Any other close is the core going down.
  provider.subscribeClose?.(() => {
    if (!closing) {
      log.event('wallet core went down under a connection', { flow: 'wallet' });
      core.faulted = true;
    }
  });
  return {
    provider,
    productId,
    close() {
      closing = true;
      provider.dispose();
    },
  };
}
