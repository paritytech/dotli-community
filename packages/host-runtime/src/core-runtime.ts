// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Boots the TrUAPI runtime behind one page core: a signing host on the local wallet when the page has one, else the
// pairing host that waits for Polkadot App.

import type {
  createWebWorkerPairingHostRuntime,
  WebWorkerHostCallbacks,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { log } from '@dotli/shared';
import type { BlockingModalScope } from './blocking-modal-queue.js';
import {
  createHostCallbacks,
  type CreateHostCallbacksOptions,
  type HostCallbackPorts,
} from './host-callbacks/handlers.js';
import { loadLocalWalletCore, type LocalWalletCoreModule } from './lazy.js';
import type { PageProduct } from './page-core.js';
import { createTruapiRuntimeConfig } from './runtime-config.js';
import { readWalletBoot, type LocalWalletBoot } from './wallet-boot.js';

export interface CoreRuntimeRequest {
  product: PageProduct;
  blockingModalScope: BlockingModalScope;
  /** False once the core is gone, so a late step of its boot stands down. */
  isLive: () => boolean;
  /**
   * False once the core went down or turned stale. Leases can keep a retired core running, and only the core in
   * service speaks for the session.
   */
  inService: () => boolean;
}

export interface BootedCoreRuntime {
  runtime: WorkerPairingHostRuntime;
  /** A local wallet core holds its session in memory, so it has no pairing and no stored session to follow. */
  local: boolean;
  /**
   * Whether a wallet read now would boot the other kind of core. A pairing core booted on a read the frame could not
   * answer turns stale once a later read finds the local wallet.
   */
  stale: () => Promise<boolean>;
}

export type BootCoreRuntime = (request: CoreRuntimeRequest) => Promise<BootedCoreRuntime>;

export interface CoreRuntimeDeps {
  readWallet: () => Promise<LocalWalletBoot | null>;
  loadHostRuntime: () => Promise<{
    createWebWorkerPairingHostRuntime: typeof createWebWorkerPairingHostRuntime;
    HostWorker: new () => Worker;
  }>;
  createCallbacks: (options: CreateHostCallbacksOptions) => WebWorkerHostCallbacks;
  loadLocalWalletCore: () => Promise<Pick<LocalWalletCoreModule, 'bootLocalWalletCore'>>;
}

export function createCoreRuntimeBoot(deps: CoreRuntimeDeps): BootCoreRuntime {
  return async ({ product, blockingModalScope, isLive, inService }) => {
    const { productId: _productId, ...hostConfig } = createTruapiRuntimeConfig(product.label, product.productId);
    const callbacksFor = (local: boolean): WebWorkerHostCallbacks =>
      deps.createCallbacks({
        label: product.label,
        pairingLabel: product.pairing?.label,
        pairingDotSuffix: product.pairing?.dotSuffix,
        pairingHostGlobal: product.pairing?.hostGlobal,
        blockingModalScope,
        local,
        inService,
      });
    // The wallet read and the host chunk load in parallel, so a Polkadot App boot waits on whichever is slower. The
    // worker wrapper fetches its worker script only when constructed, so local mode pays nothing for it.
    const [wallet, { createWebWorkerPairingHostRuntime, HostWorker }] = await Promise.all([
      deps.readWallet(),
      deps.loadHostRuntime(),
    ]);
    if (wallet !== null) {
      const { bootLocalWalletCore } = await deps.loadLocalWalletCore();
      const runtime = await bootLocalWalletCore(
        createWebWorkerPairingHostRuntime,
        callbacksFor(true),
        hostConfig,
        wallet,
        isLive,
      );
      log.event('wallet core booted', { flow: 'wallet', local: true });
      // A local wallet is forgotten only by a switch, which reloads the page.
      return { runtime, local: true, stale: () => Promise.resolve(false) };
    }
    const runtime = await createWebWorkerPairingHostRuntime(new HostWorker(), callbacksFor(false), { hostConfig });
    log.event('wallet core booted', { flow: 'wallet' });
    return { runtime, local: false, stale: async () => (await deps.readWallet()) !== null };
  };
}

/** The page's boot: the wallet read from the shared store, the published host runtime and callbacks on `ports`. */
export const pageCoreRuntimeBoot = (ports: HostCallbackPorts): BootCoreRuntime =>
  createCoreRuntimeBoot({
    readWallet: readWalletBoot,
    loadHostRuntime: async () => {
      const [web, worker] = await Promise.all([
        import('@parity/truapi-host/web'),
        import('@parity/truapi-host/worker-runtime?worker'),
      ]);
      return { createWebWorkerPairingHostRuntime: web.createWebWorkerPairingHostRuntime, HostWorker: worker.default };
    },
    createCallbacks: options => createHostCallbacks({ ...options, ...ports }),
    loadLocalWalletCore,
  });
