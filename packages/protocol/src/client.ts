// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's protocol client: the frame and the facades built on it, and the page's one instance.

import { BASE_DOMAIN, DEV_PROTOCOL_PORT, isLocalhost } from '@dotli/config';
import { createProtocolFrame, type ProtocolFrameConfig, type ProtocolFrameDeps, type ProtocolStatus } from './frame.js';
import { createFrameRpc } from './rpc.js';
import { createRemoteChains } from './remote-chain.js';
import { createRemoteResolve } from './remote-resolve.js';
import { createSharedStore } from './shared-store.js';
import { createFrameTelemetry } from './telemetry.js';

export { isRemoteChainConnectable, isRemoteChainSupported } from './remote-chain-support.js';
export type { RemoteChainProvider } from './remote-chain.js';

export type { ProtocolFrameConfig, ProtocolFrameMode, ProtocolStatus } from './frame.js';

export type { SharedStoreStatus } from './shared-store.js';

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
  // In this order, so a lost frame fails rpc requests before chains halt, and a halt carries that trail.
  const frame = createProtocolFrame(deps);
  const rpc = createFrameRpc(frame);
  const chains = createRemoteChains({ frame, rpc });
  const sharedStore = createSharedStore({ frame, rpc });
  return {
    ensureProtocolFrame: (): Promise<void> => frame.whenUp('ready'),
    getProtocolStatus: (): ProtocolStatus => frame.getStatus(),
    /** Called on each change only. Does not start a frame. */
    subscribeProtocolStatus: (listener: (status: ProtocolStatus) => void) => frame.subscribeStatus(listener),
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
    ...createFrameTelemetry(frame),
    ...chains,
  };
}

export type ProtocolClient = ReturnType<typeof createProtocolClient>;

let page: ProtocolClient | null = null;

/** The page's one client, built on first use so a worker that imports this package never touches `window`. */
function client(): ProtocolClient {
  page ??= createProtocolClient({ origin: getProtocolOrigin(), document, window });
  return page;
}

// The page's client as plain functions. Each takes its type from the client and passes every argument on, so a
// signature is written once.
export const ensureProtocolFrame: ProtocolClient['ensureProtocolFrame'] = (...args) =>
  client().ensureProtocolFrame(...args);
export const getProtocolStatus: ProtocolClient['getProtocolStatus'] = (...args) => client().getProtocolStatus(...args);
export const configureProtocolFrame: ProtocolClient['configureProtocolFrame'] = (...args) => {
  client().configureProtocolFrame(...args);
};
export const getSharedStoreStatus: ProtocolClient['getSharedStoreStatus'] = (...args) =>
  client().getSharedStoreStatus(...args);
export const subscribeSharedStoreStatus: ProtocolClient['subscribeSharedStoreStatus'] = (...args) =>
  client().subscribeSharedStoreStatus(...args);
export const getSmoldotDbOutcome: ProtocolClient['getSmoldotDbOutcome'] = (...args) =>
  client().getSmoldotDbOutcome(...args);
export const warmupProtocol: ProtocolClient['warmupProtocol'] = (...args) => client().warmupProtocol(...args);
export const resolveDotNameRemote: ProtocolClient['resolveDotNameRemote'] = (...args) =>
  client().resolveDotNameRemote(...args);
/**
 * Reads a name's owner through the protocol frame.
 * @public Kept with the frame's `resolveOwner` request, which pages embedding the frame may send, though no dotli page
 * calls it today.
 */
export const resolveOwnerRemote: ProtocolClient['resolveOwnerRemote'] = (...args) =>
  client().resolveOwnerRemote(...args);
export const resolveExecutableManifestRemote: ProtocolClient['resolveExecutableManifestRemote'] = (...args) =>
  client().resolveExecutableManifestRemote(...args);
export const resolveRootManifestRemote: ProtocolClient['resolveRootManifestRemote'] = (...args) =>
  client().resolveRootManifestRemote(...args);
export const readSharedAuthStorage: ProtocolClient['readSharedAuthStorage'] = (...args) =>
  client().readSharedAuthStorage(...args);
export const writeSharedAuthStorage: ProtocolClient['writeSharedAuthStorage'] = (...args) =>
  client().writeSharedAuthStorage(...args);
export const clearSharedAuthStorage: ProtocolClient['clearSharedAuthStorage'] = (...args) =>
  client().clearSharedAuthStorage(...args);
export const readSharedModeStorage: ProtocolClient['readSharedModeStorage'] = (...args) =>
  client().readSharedModeStorage(...args);
export const writeSharedModeStorage: ProtocolClient['writeSharedModeStorage'] = (...args) =>
  client().writeSharedModeStorage(...args);
export const clearSharedModeStorage: ProtocolClient['clearSharedModeStorage'] = (...args) =>
  client().clearSharedModeStorage(...args);
export const readSharedLocalWallet: ProtocolClient['readSharedLocalWallet'] = (...args) =>
  client().readSharedLocalWallet(...args);
export const saveSharedLocalWallet: ProtocolClient['saveSharedLocalWallet'] = (...args) =>
  client().saveSharedLocalWallet(...args);
export const updateSharedLocalWalletIdentity: ProtocolClient['updateSharedLocalWalletIdentity'] = (...args) =>
  client().updateSharedLocalWalletIdentity(...args);
export const forgetSharedLocalWallet: ProtocolClient['forgetSharedLocalWallet'] = (...args) =>
  client().forgetSharedLocalWallet(...args);
export const subscribeSharedAuthStorage: ProtocolClient['subscribeSharedAuthStorage'] = (...args) =>
  client().subscribeSharedAuthStorage(...args);
export const onProtocolChainSync: ProtocolClient['onProtocolChainSync'] = (...args) =>
  client().onProtocolChainSync(...args);
export const onProtocolChainDetail: ProtocolClient['onProtocolChainDetail'] = (...args) =>
  client().onProtocolChainDetail(...args);
export const onProtocolNetBytes: ProtocolClient['onProtocolNetBytes'] = (...args) =>
  client().onProtocolNetBytes(...args);
export const createRemoteChainProvider: ProtocolClient['createRemoteChainProvider'] = (...args) =>
  client().createRemoteChainProvider(...args);
