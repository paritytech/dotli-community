// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI wiring from its parts: one page core, the topbar's login and logout on it, and the product frame
// piped to it. Nested products are not modeled separately, so any nested traffic must share the top-level core.

import type { SandboxChannel } from '@dotli/sandbox-wire';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createCoreAuthCommands, type AuthCommands, type CoreAuthCommandsDeps } from './core-login.js';
import type { BootCoreRuntime } from './core-runtime.js';
import { createPageCore, type PageCore, type PageProduct } from './page-core.js';
import { createProductFrame, type ProductFrame, type ProductFrameDeps } from './product-frame.js';

export interface BridgeDeps extends Omit<CoreAuthCommandsDeps, 'core'> {
  bootRuntime: BootCoreRuntime;
  /** Returns the unsubscribe. */
  onStoredSessionChanged: (listener: () => void) => () => void;
  createIframeHost: ProductFrameDeps['createIframeHost'];
  onPermissionsChanged: ProductFrameDeps['onPermissionsChanged'];
  /** Where the product frame routes its connections' permissions. */
  permissions: ProductFrameDeps['permissions'];
  /** What the page shows around the frame. */
  frameView: ProductFrameDeps['view'];
  /** The page's notifications, for a reload the frame could not do itself. */
  notify: ProductFrameDeps['notify'];
  /** Starts telling the network panel who holds each host chain and its best blocks, without holding any. */
  watchChains: () => void;
}

export interface Bridge {
  /**
   * Builds the page core on the page's blocking-modal queue and starts reporting the host chains' activity. A repeated
   * call keeps the first core.
   */
  initBridge: (coordinator: BlockingModalCoordinator) => void;
  /** Called as soon as the page knows it, so a core booted by an early login is already the product's. */
  setPageProduct: (product: PageProduct) => void;
  /**
   * Builds the page's product frame, which a reloaded sandbox reaches over `channel`. After `initBridge`. A repeated
   * call keeps the first frame.
   */
  startProductFrame: (channel: SandboxChannel) => ProductFrame;
  authCommands: AuthCommands;
}

export function createBridge(deps: BridgeDeps): Bridge {
  let core: PageCore | null = null;
  let productFrame: ProductFrame | null = null;

  const getCore = (): PageCore => {
    if (core === null) {
      throw new Error('TrUAPI page core used before initBridge');
    }
    return core;
  };

  return {
    initBridge(coordinator) {
      if (core !== null) {
        return;
      }
      deps.watchChains();
      core = createPageCore({
        bootRuntime: deps.bootRuntime,
        onStoredSessionChanged: deps.onStoredSessionChanged,
        coordinator,
      });
    },
    setPageProduct(product) {
      getCore().setProduct(product);
    },
    startProductFrame(channel) {
      productFrame ??= createProductFrame({
        core: getCore(),
        createIframeHost: deps.createIframeHost,
        channel,
        onPermissionsChanged: deps.onPermissionsChanged,
        permissions: deps.permissions,
        view: deps.frameView,
        notify: deps.notify,
      });
      return productFrame;
    },
    authCommands: createCoreAuthCommands({
      auth: deps.auth,
      core: {
        acquire: () => getCore().acquire(),
        cancelPairing: () => {
          // Before the core is built there is no pairing to cancel.
          core?.cancelPairing();
        },
      },
      session: deps.session,
      walletMode: deps.walletMode,
      leaveLocalWallet: deps.leaveLocalWallet,
    }),
  };
}
