// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI core. A page hosts one product, so it runs one core,
// created under that product's label: the product frame, the topbar's login
// and logout, and pairing cancels all lease the same core and open their own
// connection to it. The core goes with its last lease. One that faulted is not
// handed out again: the next lease boots a fresh one.

import type { ProductExecutionKind, TrUApiProductProvider } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createHostCallbacks } from './host-callbacks/handlers.js';
import { onStoredSessionChanged } from './host-callbacks/SessionStore.js';
import { createTruapiRuntimeConfig, labelToProductId } from './runtime-config.js';

export interface PageProduct {
  /** The label the core's prompts, notifications and permissions go under. */
  label: string;
  /** Overrides the label-derived product id (the local debug routes). */
  productId?: string | undefined;
  /** How pairing presents itself, when not as the product. */
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
}

/** A connection to the core. Close it through `close`, never the provider. */
export interface CoreConnection {
  provider: TrUApiProductProvider;
  productId: string;
  close(): void;
}

export interface CoreLease {
  runtime: WorkerPairingHostRuntime;
  /** Open a connection to the core as the page's product. */
  connect(executionKind?: ProductExecutionKind): Promise<CoreConnection>;
  /** Give the lease back; the last one disposes the core. Idempotent. */
  release(): void;
}

interface Core {
  product: PageProduct;
  runtime: Promise<WorkerPairingHostRuntime>;
  leases: number;
  faulted: boolean;
  dispose(): void;
}

// The landing page has no product: its core logs in and out as dot.li
// itself, and pairing presents host-wide.
const LANDING_PRODUCT: PageProduct = {
  label: 'dotli',
  pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
};

let modalCoordinator: BlockingModalCoordinator | null = null;
let pageProduct: PageProduct = LANDING_PRODUCT;
let current: Core | null = null;
// Every core not yet disposed: `current`, plus one a product change or a
// fault replaced while it still had leases.
const cores = new Set<Core>();

export function initPageCore(coordinator: BlockingModalCoordinator): void {
  modalCoordinator = coordinator;
}

/**
 * Declare the product this page hosts. Called as soon as the page knows it,
 * so a core booted before the product renders (a login clicked early) is
 * already the product's.
 */
export function setPageProduct(product: PageProduct): void {
  pageProduct = product;
}

function productIdOf(product: PageProduct): string {
  return product.productId ?? labelToProductId(product.label);
}

function isPageProduct(core: Core): boolean {
  return core.product.label === pageProduct.label && productIdOf(core.product) === productIdOf(pageProduct);
}

/** Lease the page's core, booting it if none is running. */
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

/** Cancel the pairing on whichever core is running one. */
export function cancelPairing(): void {
  for (const core of cores) {
    core.runtime.then(
      runtime => {
        runtime.cancelPairing();
      },
      () => {
        /* a core that never booted has no pairing to cancel */
      },
    );
  }
}

function createCore(product: PageProduct): Core {
  if (modalCoordinator === null) {
    throw new Error('TrUAPI page core used before initPageCore');
  }
  const blockingModalScope = modalCoordinator.createScope();
  const { productId: _productId, ...hostConfig } = createTruapiRuntimeConfig(product.label, product.productId);
  let unsubscribeStore: (() => void) | null = null;
  const runtime = Promise.all([import('@parity/truapi-host/web'), import('@parity/truapi-host/worker-runtime?worker')])
    .then(([{ createWebWorkerPairingHostRuntime }, { default: HostWorker }]) =>
      createWebWorkerPairingHostRuntime(
        new HostWorker(),
        createHostCallbacks({
          label: product.label,
          pairingLabel: product.pairing?.label,
          pairingDotSuffix: product.pairing?.dotSuffix,
          pairingHostGlobal: product.pairing?.hostGlobal,
          blockingModalScope,
        }),
        { hostConfig },
      ),
    )
    .then(booted => {
      // Another tab logging in or out lands in the shared session store; the
      // core reads it again. Once now too, for a session stored before boot.
      unsubscribeStore = onStoredSessionChanged(() => {
        booted.notifySessionStoreChanged();
      });
      queueMicrotask(() => {
        if (cores.has(core)) {
          booted.notifySessionStoreChanged();
        }
      });
      return booted;
    });
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
      unsubscribeStore?.();
      blockingModalScope.dispose();
      runtime.then(
        booted => {
          booted.dispose();
        },
        () => {
          /* nothing booted, nothing to dispose */
        },
      );
    },
  };
  cores.add(core);
  runtime.catch(() => {
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
    core.faulted = true;
    throw error;
  }
  let closing = false;
  // Closing a connection on purpose also fires its close listeners; any
  // other close is the core going down under it.
  provider.subscribeClose?.(() => {
    if (!closing) {
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
