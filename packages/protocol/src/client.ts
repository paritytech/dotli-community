// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's protocol client: the frame and the facades built on it, and the page's one instance.

import { BASE_DOMAIN, DEV_PROTOCOL_PORT, isLocalhost } from '@dotli/config';
import { realTimers } from '@dotli/shared';
import type { ProtocolVersionMismatchError } from './errors.js';
import { createProtocolFrame, type ProtocolFrameConfig, type ProtocolFrameDeps, type ProtocolStatus } from './frame.js';
import { createFrameRpc } from './rpc.js';
import { createRemoteChains } from './remote-chain.js';
import { createRemoteResolve } from './remote-resolve.js';
import { createSharedStore } from './shared-store.js';
import { createFrameTelemetry } from './telemetry.js';

export { isRemoteChainConnectable, isRemoteChainSupported } from './remote-chain-support.js';
export type { RemoteChainProvider } from './remote-chain.js';

export type { ProtocolFrameConfig, ProtocolStatus } from './frame.js';

export type { LocalWalletReadResult, SharedStoreStatus } from './shared-store.js';

export function getProtocolOrigin(): string {
  if (isLocalhost) {
    if (import.meta.env.DEV) {
      return `http://host.localhost:${DEV_PROTOCOL_PORT}`;
    }
    const port = window.location.port.length > 0 ? window.location.port : '5173';
    return `http://host.localhost:${port}`;
  }
  return `https://host.${BASE_DOMAIN}`;
}

/** The host page's side of the protocol frame, on `deps`. The page builds one, and a spec builds one per test. */
export function createProtocolClient(deps: ProtocolFrameDeps) {
  const frame = createProtocolFrame(deps);
  const timers = deps.timers ?? realTimers;
  const rpc = createFrameRpc(frame, timers);
  const chains = createRemoteChains({ frame, rpc, timers });
  const sharedStore = createSharedStore({ frame, rpc, timers });
  return {
    async ensureProtocolFrame(): Promise<void> {
      await frame.whenUp('ready');
    },
    getProtocolStatus: (): ProtocolStatus => frame.getStatus(),
    /** Called on each change only. Does not start a frame. */
    subscribeProtocolStatus: (listener: (status: ProtocolStatus) => void) => frame.subscribeStatus(listener),
    /**
     * Hears once that a frame refused this page's wire version, at once if one already did. The frame stays down for
     * good, since only a reload loads a matching page.
     */
    onProtocolVersionMismatch: (listener: (error: ProtocolVersionMismatchError) => void) =>
      frame.onVersionMismatch(listener),
    /**
     * Says what the frame is built with. Nothing boots before it, and requests made before the first config wait for
     * it up to a bound, so callers need not order themselves around the host's boot. The same config again does
     * nothing. A different one rebuilds a frame already asked for at once: its requests and ready waiters are rejected
     * and its chain connections halt as for a dead frame. A SharedWorker keeps its sync progress, only this tab's port
     * cycles.
     */
    configureProtocolFrame: (config: ProtocolFrameConfig): void => {
      frame.configure(config);
    },
    ...sharedStore,
    ...createRemoteResolve({ frame, rpc, timers }),
    ...createFrameTelemetry(frame, timers),
    ...chains,
  };
}

export type ProtocolClient = ReturnType<typeof createProtocolClient>;

let page: ProtocolClient | null = null;

/** The page's one client, built on first use so a worker that imports this package never touches `window`. */
export function protocolClient(): ProtocolClient {
  page ??= createProtocolClient({ origin: getProtocolOrigin(), document, window });
  return page;
}
