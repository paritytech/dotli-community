// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Boots the TrUAPI runtime behind one page core: a signing host on the local wallet when the page has one, else the
// pairing host that waits for Polkadot App.

import type { ProductId } from '@parity/truapi';
import type {
  createWebWorkerPairingHostRuntime,
  WebWorkerHostCallbacks,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { log } from '@dotli/shared';
import type { BlockingModalScope } from './createBlockingModalCoordinator.js';
import type { CoreCallbacksParams } from './hostCallbacks/createHostCallbacks.js';
import type { LocalWalletCoreModule } from '../lazy.js';
import type { PageProduct } from './createPageCore.js';
import type { PhoneRequestTracker } from './createPhoneRequestTracker.js';
import { createTruapiRuntimeConfig, toProductId } from './createTruapiRuntimeConfig.js';
import { ERRORS } from './errors.js';
import type { LocalWalletBoot } from './createWalletBoot.js';

export type CoreRuntimeRequest = {
  product: PageProduct;
  blockingModalScope: BlockingModalScope;
  /** What the core's frames report phone requests to, and its confirmations claim from. */
  phoneRequests: PhoneRequestTracker;
  /** False once the core is gone, so a late step of its boot stands down. */
  isLive: () => boolean;
  /**
   * False once the core went down or turned stale. Leases can keep a retired core running, and only the core in
   * service speaks for the session.
   */
  isInService: () => boolean;
  /**
   * Keeps the core's session slot in memory, so nothing it does reaches the stored session or the signed-in flag. For
   * a core that must never write either.
   */
  sessionInMemory?: boolean;
};

export type BootedCoreRuntime = {
  runtime: WorkerPairingHostRuntime;
  /** The product id the core parsed from the one the product asks for, which every connection runs under. */
  productId: ProductId;
  /** A local wallet core holds its session in memory, so it has no pairing and no stored session to follow. */
  local: boolean;
  /**
   * Whether a wallet read now would boot the other kind of core. A pairing core booted on a read the frame could not
   * answer turns stale once a later read finds the local wallet. Never rejects.
   */
  isStale: () => Promise<boolean>;
};

export type CoreRuntimeBootParams = {
  /** The local wallet the page boots on, or null to boot the pairing host. Never rejects. */
  readWallet: () => Promise<LocalWalletBoot | null>;
  /** Loads the published host runtime. Rejects when it fails to load. */
  loadHostRuntime: () => Promise<{
    createWebWorkerPairingHostRuntime: typeof createWebWorkerPairingHostRuntime;
    HostWorker: new () => Worker;
  }>;
  /** Builds the callbacks a core asks the page through. */
  createCallbacks: (params: CoreCallbacksParams) => WebWorkerHostCallbacks;
  /** Loads the local wallet core's chunk. Rejects when it fails to load. */
  loadLocalWalletCore: () => Promise<Pick<LocalWalletCoreModule, 'bootLocalWalletCore'>>;
};

export type BootCoreRuntime = ReturnType<typeof createCoreRuntimeBoot>;

/** Returns the boot of one core's runtime. Never throws. */
export function createCoreRuntimeBoot({
  readWallet,
  loadHostRuntime,
  createCallbacks,
  loadLocalWalletCore,
}: CoreRuntimeBootParams) {
  /** Resolves with the booted runtime. Rejects when a step of the boot fails. */
  async function bootCoreRuntime({
    product,
    blockingModalScope,
    phoneRequests,
    isLive,
    isInService,
    sessionInMemory = false,
  }: CoreRuntimeRequest): Promise<BootedCoreRuntime> {
    const hostConfig = createTruapiRuntimeConfig();
    // Set once the core parsed it, which needs the booted core, while the callbacks are built before the boot.
    let productId: ProductId | undefined;
    function getProductId(): ProductId {
      if (productId === undefined) {
        throw new Error(ERRORS.PRODUCT_ID_NOT_READY);
      }
      return productId;
    }
    const createCoreCallbacks = (local: boolean): WebWorkerHostCallbacks =>
      createCallbacks({
        label: product.label,
        getProductId,
        pairingLabel: product.pairing?.label,
        pairingDotSuffix: product.pairing?.dotSuffix,
        pairingHostGlobal: product.pairing?.hostGlobal,
        blockingModalScope,
        sessionInMemory: local || sessionInMemory,
        isInService,
        phoneRequests,
      });
    // The wallet read and the host chunk load in parallel, so a Polkadot App boot waits on whichever is slower. The
    // worker wrapper fetches its worker script only when constructed, so local mode pays nothing for it.
    const [wallet, { createWebWorkerPairingHostRuntime, HostWorker }] = await Promise.all([
      readWallet(),
      loadHostRuntime(),
    ]);
    if (wallet !== null) {
      const { bootLocalWalletCore } = await loadLocalWalletCore();
      const runtime = await bootLocalWalletCore({
        create: createWebWorkerPairingHostRuntime,
        callbacks: createCoreCallbacks(true),
        hostConfig,
        wallet,
        isLive,
      });
      productId = await parseProductId(runtime, product);
      log.event('wallet core booted', { flow: 'wallet', local: true });
      // A local wallet is forgotten only by a switch, which reloads the page.
      return { runtime, productId, local: true, isStale: () => Promise.resolve(false) };
    }
    const runtime = await createWebWorkerPairingHostRuntime(new HostWorker(), createCoreCallbacks(false), {
      hostConfig,
    });
    productId = await parseProductId(runtime, product);
    log.event('wallet core booted', { flow: 'wallet' });
    return { runtime, productId, local: false, isStale: async () => (await readWallet()) !== null };
  }

  return bootCoreRuntime;
}

/**
 * Resolves with the id the core parses from the one `product` asks for, so the core alone owns the id's rules. Rejects
 * when the core refuses it, having disposed the runtime, which nobody else holds yet.
 */
async function parseProductId(runtime: WorkerPairingHostRuntime, product: PageProduct): Promise<ProductId> {
  try {
    return await runtime.parseProductId(product.productId ?? toProductId(product.label));
  } catch (error) {
    runtime.dispose();
    throw new Error('The core refused the product id', { cause: error });
  }
}
