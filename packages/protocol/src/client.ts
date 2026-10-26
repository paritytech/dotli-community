// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's protocol client: the frame and the facades built on it, and the page's one instance.

import { BASE_DOMAIN, DEV_HOST_PORT, LOCAL_ROOT } from '@dotli/config';
import { realTimers } from '@dotli/shared';
import type { ProtocolVersionMismatchError } from './errors.js';
import {
  createProtocolFrame,
  type FrameElement,
  type ProtocolFrameConfig,
  type ProtocolFrameDeps,
  type ProtocolStatus,
} from './frame.js';
import { createFrameRpc } from './rpc.js';
import { createRemoteChains } from './remote-chain.js';
import { createRemoteResolve } from './remote-resolve.js';
import { createSharedStore } from './shared-store.js';
import { createFrameTelemetry } from './telemetry.js';

/** The page's own facts, so a spec can place the page without a `window`. */
export interface ProtocolOriginEnv {
  /** The local root the page is served under, which a local frame shares, or `null` when deployed. */
  localRoot: string | null;
  dev: boolean;
  /** The page's own scheme with its colon, which a local frame shares. */
  protocol: string;
  port: string;
}

function pageEnv(): ProtocolOriginEnv {
  const { protocol, port } = window.location;
  return { localRoot: LOCAL_ROOT, dev: import.meta.env.DEV, protocol, port };
}

function localPort(env: ProtocolOriginEnv): string {
  if (env.dev) {
    return DEV_HOST_PORT;
  }
  return env.port.length > 0 ? env.port : '5173';
}

/** The origin the hidden protocol frame loads from: the root domain's, or the local root's on a local page. */
export function getProtocolOrigin(env: ProtocolOriginEnv = pageEnv()): string {
  if (env.localRoot !== null) {
    // Dev serves the frame from the host's own dev server. Preview and tests serve it on the page's port.
    const port = localPort(env);
    return `${env.protocol}//${env.localRoot}:${port}`;
  }
  return `https://${BASE_DOMAIN}`;
}

/** The host page's side of the protocol frame, on `deps`. The page builds one, and a spec builds one per test. */
export function createProtocolClient<E extends FrameElement>(deps: ProtocolFrameDeps<E>) {
  const frame = createProtocolFrame(deps);
  const timers = deps.timers ?? realTimers;
  const rpc = createFrameRpc(frame, timers);
  const chains = createRemoteChains(rpc);
  const sharedStore = createSharedStore({ frame, rpc, timers });
  return {
    async ensureProtocolFrame(): Promise<void> {
      await frame.whenReady();
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
    ...createRemoteResolve(rpc),
    ...createFrameTelemetry(frame, timers),
    ...chains,
  };
}

export type ProtocolClient = ReturnType<typeof createProtocolClient>;

let page: ProtocolClient | null = null;

/** The page's one client, built on first use so a worker that imports this package never touches `window`. */
export function protocolClient(): ProtocolClient {
  page ??= createProtocolClient<HTMLIFrameElement>({ origin: getProtocolOrigin(), document, window });
  return page;
}
