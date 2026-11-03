// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's protocol client: the frame and the facades built on it, and the page's one instance.

import { realTimers } from '@dotli/shared';
import { createFrameRpc } from './createFrameRpc.js';
import { createFrameTelemetry } from './createFrameTelemetry.js';
import { createProtocolFrame } from './createProtocolFrame.js';
import { createRemoteChains } from './createRemoteChains.js';
import { createRemoteResolve } from './createRemoteResolve.js';
import { createSharedStore } from './createSharedStore.js';
import type { ProtocolVersionMismatchError } from './errors.js';
import type { FrameElement, ProtocolFrameConfig, ProtocolFrameParams, ProtocolStatus } from './frameTypes.js';
import { getProtocolOrigin } from './getProtocolOrigin.js';

export type ProtocolClient = ReturnType<typeof createProtocolClient>;

let page: ProtocolClient | null = null;

/** The host page's side of the protocol frame, on `params`. The page builds one, and a spec builds one per test. */
export function createProtocolClient<E extends FrameElement>(params: ProtocolFrameParams<E>) {
  const frame = createProtocolFrame(params);
  const timers = params.timers ?? realTimers;
  const rpc = createFrameRpc({ frame, timers });
  const { status, auth, mode, wallet } = createSharedStore({ frame, rpc, timers });
  return {
    /** The protocol frame's lifecycle: its config, readiness and status. */
    frame: {
      /**
       * Resolves once the frame is ready, booting one if none was asked for yet. Rejects with the error the boot it
       * waits on failed with, such as a `ProtocolInitFailedError`, a `ProtocolVersionMismatchError` or an `Error` with a
       * `PROTOCOL_ERRORS` text, and with an `Error` of the `FRAME_RESET` text when a config change drops the frame,
       * unless a status listener queued ahead of it has already asked for the rebuilt frame, and then it waits on that
       * frame.
       */
      async ensureReady(): Promise<void> {
        await frame.waitUntilReady();
      },
      /** The frame's status now. Never throws. */
      getStatus: (): ProtocolStatus => frame.getStatus(),
      /**
       * Called on each change only, with the status there is when its turn comes, so within one round of listeners it
       * can hear the same status twice and miss one. Does not start a frame. Returns the unsubscribe.
       */
      subscribeStatus: (listener: (status: ProtocolStatus) => void) => frame.subscribeStatus(listener),
      /**
       * Hears once that a frame refused this page's wire version, at once if one already did. The frame stays down for
       * good, since only a reload loads a matching page. Returns the unsubscribe.
       */
      subscribeVersionMismatch: (listener: (error: ProtocolVersionMismatchError) => void) =>
        frame.onVersionMismatch(listener),
      /**
       * Says what the frame is built with. Nothing boots before it, and requests made before the first config wait for
       * it up to a bound, so callers need not order themselves around the host's boot. The same config again does
       * nothing. A different one rebuilds a frame already asked for at once: its requests and ready waiters are
       * rejected, except a ready waiter queued behind a status listener that already asked for the rebuilt frame, which
       * waits on that frame, and its chain connections halt as for a dead frame. A SharedWorker keeps its sync progress,
       * only this tab's port cycles. Never throws.
       */
      configure: (config: ProtocolFrameConfig): void => {
        frame.configure(config);
      },
    },
    /** Whether the shared store can answer. */
    sharedStore: status,
    /** The auth store, shared by the sites on the same root domain. */
    sharedAuth: auth,
    /** The mode store, shared by the sites on the same root domain. */
    sharedMode: mode,
    /** The local wallet record of each site, shared by the sites on the same root domain. */
    sharedWallet: wallet,
    /** Name and manifest resolution in the frame. */
    resolve: createRemoteResolve({ rpc }),
    /** What the frame reports about its light client, heard from each frame there is without booting one. */
    telemetry: createFrameTelemetry({ frame, timers }),
    /** Connections to the frame's chains. */
    chains: createRemoteChains({ rpc }),
  };
}

/** The page's one client, built on first use so a worker that imports this package never touches `window`. */
export function getProtocolClient(): ProtocolClient {
  page ??= createProtocolClient<HTMLIFrameElement>({ origin: getProtocolOrigin(), document, window });
  return page;
}
