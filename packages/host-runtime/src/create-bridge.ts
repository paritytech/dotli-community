// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI wiring from its parts: one page core, the topbar's login and logout on it, and the product frame
// piped to it. Nested products are not modeled separately, so any nested traffic must share the top-level core.

import type { ChainPoolWatcher } from '@dotli/chains';
import type { SandboxChannel } from '@dotli/sandbox-wire';
import type { AuthCommands } from './auth-commands.js';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createCoreAuthCommands, type CoreAuthCommandsDeps } from './core-login.js';
import type { BootCoreRuntime } from './core-runtime.js';
import type { HostCallbackPorts } from './host-callbacks/handlers.js';
import { createPageCore, type PageCore, type PageProduct } from './page-core.js';
import {
  createProductFrame,
  type ProductFrame,
  type ProductFrameDeps,
  type ProductFrameView,
} from './product-frame.js';

export interface BridgeDeps extends Omit<CoreAuthCommandsDeps, 'core'> {
  /** Boots a core whose callbacks ask the page through `ports`. */
  bootRuntime: (ports: HostCallbackPorts) => BootCoreRuntime;
  /** Returns the unsubscribe. */
  onStoredSessionChanged: (listener: () => void) => () => void;
  createIframeHost: ProductFrameDeps['createIframeHost'];
  /** Where the product frame mounts, read once when it starts. */
  container: () => HTMLElement;
  onPermissionsChanged: ProductFrameDeps['onPermissionsChanged'];
  /** Attaches a watcher to the host's chains. */
  watchChains: (watcher: ChainPoolWatcher) => void;
}

/**
 * What the page gives the bridge: the queue its prompts wait in, the user's answers, the frame's view and where the host
 * chains' activity goes.
 */
export interface BridgePorts extends HostCallbackPorts {
  coordinator: BlockingModalCoordinator;
  frameView: ProductFrameView;
  /** Hears who holds each host chain and its best blocks, without holding any. */
  chainActivity: ChainPoolWatcher;
}

export interface Bridge {
  /**
   * Builds the page core on the page's ports and starts reporting the host chains' activity. A repeated call keeps the
   * first core and ports.
   */
  initBridge: (ports: BridgePorts) => void;
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
  // The core and the ports it was built on arrive together, in the first initBridge.
  let page: { core: PageCore; ports: BridgePorts } | null = null;
  let productFrame: ProductFrame | null = null;

  const getPage = (): { core: PageCore; ports: BridgePorts } => {
    if (page === null) {
      throw new Error('TrUAPI page core used before initBridge');
    }
    return page;
  };

  return {
    initBridge(ports) {
      if (page !== null) {
        return;
      }
      deps.watchChains(ports.chainActivity);
      page = {
        core: createPageCore({
          bootRuntime: deps.bootRuntime({ prompts: ports.prompts, notifications: ports.notifications }),
          onStoredSessionChanged: deps.onStoredSessionChanged,
          coordinator: ports.coordinator,
        }),
        ports,
      };
    },
    setPageProduct(product) {
      getPage().core.setProduct(product);
    },
    startProductFrame(channel) {
      if (productFrame === null) {
        const { core, ports } = getPage();
        productFrame = createProductFrame({
          core,
          createIframeHost: deps.createIframeHost,
          container: deps.container(),
          channel,
          onPermissionsChanged: deps.onPermissionsChanged,
          view: ports.frameView,
          notify: ports.prompts.notify,
        });
      }
      return productFrame;
    },
    authCommands: createCoreAuthCommands({
      auth: deps.auth,
      core: {
        acquire: () => getPage().core.acquire(),
        cancelPairing: () => {
          // Before the core is built there is no pairing to cancel.
          page?.core.cancelPairing();
        },
      },
      session: deps.session,
      walletMode: deps.walletMode,
      leaveLocalWallet: deps.leaveLocalWallet,
    }),
  };
}
