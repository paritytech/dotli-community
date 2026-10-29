// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI wiring from its parts: one page core, the product frame piped to it, and a core of its own for a
// session the page ends on the phone. Nested products are not modeled separately, so any nested traffic must share the
// top-level core.

import type { SandboxChannel } from '@dotli/sandbox-wire';
import { createAsyncTaskPool } from '@dotli/shared';
import type { BlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import type { SessionState } from './session/createSessionState.js';
import type { BootCoreRuntime, BootedCoreRuntime } from './createCoreRuntimeBoot.js';
import { createPageCore, LANDING_PRODUCT, type PageCore, type PageProduct } from './createPageCore.js';
import { createPhoneRequestTracker } from './createPhoneRequestTracker.js';
import { createProductFrame, type ProductFrame, type ProductFrameParams } from './createProductFrame.js';

export type Bridge = ReturnType<typeof createBridge>;

type Params = {
  /** Boots a core for a request. Rejects when the boot fails. */
  bootRuntime: BootCoreRuntime;
  /** Subscribes to each change of the stored session and returns the unsubscribe. */
  subscribeStoredSession: (listener: () => void) => () => void;
  createIframeHost: ProductFrameParams['createIframeHost'];
  subscribePermissionChanges: ProductFrameParams['subscribePermissionChanges'];
  /** Where the product frame routes its connections' permissions. */
  permissions: ProductFrameParams['permissions'];
  /** What the page shows around the frame. */
  frameView: ProductFrameParams['view'];
  /** The page's notifications, for a reload the frame could not do itself. */
  notify: ProductFrameParams['notify'];
  /** Starts telling the network panel who holds each host chain and its best blocks, without holding any. */
  watchChains: () => void;
  session: Pick<SessionState, 'reportCoresGone'>;
};

/** Builds the page's TrUAPI wiring, with no core until `initBridge`. Building it never throws. */
export function createBridge({
  bootRuntime,
  subscribeStoredSession,
  createIframeHost,
  subscribePermissionChanges,
  permissions,
  frameView,
  notify,
  watchChains,
  session,
}: Params) {
  let initialised: { core: PageCore; modals: BlockingModalCoordinator } | null = null;
  let productFrame: ProductFrame | null = null;
  // The core tells the phone in a task of its own once its disconnect has answered, which disposing it would cut, so a
  // core that ended a session stays. One that failed goes, and the next end boots another.
  let endingCore: { booted: Promise<BootedCoreRuntime>; dispose(): void } | null = null;
  const endings = createAsyncTaskPool({ poolSize: 1 });

  function requireInitialised(): NonNullable<typeof initialised> {
    if (initialised === null) {
      throw new Error('TrUAPI page core used before initBridge');
    }
    return initialised;
  }

  /**
   * The core that ends a session. Not the page core, which follows the stored session and would read the memory-only
   * slot as no session.
   */
  function bootEndingCore(): NonNullable<typeof endingCore> {
    if (endingCore !== null) {
      return endingCore;
    }
    const blockingModalScope = requireInitialised().modals.createScope();
    const phoneRequests = createPhoneRequestTracker();
    let live = true;
    const booted = bootRuntime({
      product: LANDING_PRODUCT,
      blockingModalScope,
      phoneRequests,
      isLive: () => live,
      isInService: () => false,
      sessionInMemory: true,
    });
    const ending = {
      booted,
      dispose() {
        if (endingCore === ending) {
          endingCore = null;
        }
        live = false;
        booted.then(
          ({ runtime }) => {
            runtime.dispose();
          },
          () => {
            // A boot that failed holds no runtime, and the caller heard why.
          },
        );
        phoneRequests.dispose();
        blockingModalScope.dispose();
      },
    };
    endingCore = ending;
    return ending;
  }

  function initBridge(coordinator: BlockingModalCoordinator): void {
    if (initialised !== null) {
      return;
    }
    watchChains();
    initialised = {
      modals: coordinator,
      core: createPageCore({
        bootRuntime,
        subscribeStoredSession,
        coordinator,
        onCoresGone: () => {
          session.reportCoresGone();
        },
      }),
    };
  }

  function setPageProduct(product: PageProduct): void {
    requireInitialised().core.setProduct(product);
  }

  function startProductFrame(channel: SandboxChannel): ProductFrame {
    productFrame ??= createProductFrame({
      core: requireInitialised().core,
      createIframeHost,
      channel,
      subscribePermissionChanges,
      permissions,
      view: frameView,
      notify,
    });
    return productFrame;
  }

  function endSession(blob: Uint8Array): Promise<void> {
    return endings.call(async () => {
      const ending = bootEndingCore();
      try {
        const { runtime } = await ending.booted;
        await runtime.activateExternalSession(blob);
        await runtime.disconnectSession();
      } catch (error) {
        ending.dispose();
        throw error;
      }
    });
  }

  const core: Pick<PageCore, 'acquire' | 'cancelPairing' | 'resetSession'> = {
    acquire: () => requireInitialised().core.acquire(),
    cancelPairing: () => {
      initialised?.core.cancelPairing();
    },
    resetSession: () => initialised?.core.resetSession() ?? Promise.resolve(),
  };

  return {
    /**
     * Builds the page core on the page's blocking-modal queue and starts reporting the host chains' activity. A
     * repeated call keeps the first core. Never throws.
     */
    initBridge,
    /**
     * Called as soon as the page knows it, so a core booted by an early login is already the product's. Throws before
     * `initBridge`.
     */
    setPageProduct,
    /**
     * Builds the page's product frame, which a reloaded sandbox reaches over `channel`. After `initBridge`, and throws
     * before it. A repeated call keeps the first frame.
     */
    startProductFrame,
    /**
     * The page core, to lease, and to cancel a pairing or reset the session of the cores it runs. Before `initBridge` a
     * lease throws a named error, and there is no core to cancel or reset.
     */
    core,
    /**
     * Installs a session the caller read from the store itself on a core of its own and ends it there, which tells the
     * phone. For a sign-out, the page's or the sign-out window's. The core keeps its session in memory and speaks for
     * no page session, so nothing it does reaches the store, the signed-in flag or the auth state. It stays up for the
     * page's life and ends one session at a time. One whose boot or end failed goes, and the next call boots another.
     * After `initBridge`. Rejects when the core's boot, the session's install or its end fails.
     */
    endSession,
  };
}
