// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's protocol client: the frame and the facades built on it, and the page's one instance.

import type { ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import { BASE_DOMAIN, DEV_PROTOCOL_PORT, type SiteId } from '@dotli/config';
import type {
  LocalWalletIdentity,
  LocalWalletReadResult,
  ProtocolChainDetailEnvelope,
  ProtocolChainSyncEnvelope,
  ProtocolNetBytesEnvelope,
  SmoldotDbChain,
  SmoldotDbOutcome,
} from './messages.js';
import { createProtocolFrame, type ProtocolFrameConfig, type ProtocolFrameDeps, type ProtocolStatus } from './frame.js';
import { createFrameRpc } from './rpc.js';
import { createRemoteChains, type RemoteChainProvider, type RemoteChains } from './remote-chain.js';
import { createRemoteResolve, type RemoteResolve } from './remote-resolve.js';
import {
  createSharedStore,
  type SharedAuthStorageListener,
  type SharedStore,
  type SharedStoreStatus,
} from './shared-store.js';
import { createFrameTelemetry, type FrameTelemetry } from './telemetry.js';

export { isRemoteChainConnectable, isRemoteChainSupported } from './remote-chain-support.js';
export type { RemoteChainProvider } from './remote-chain.js';

export type { ProtocolFrameConfig, ProtocolFrameMode, ProtocolStatus } from './frame.js';

export type { SharedAuthStorageListener, SharedStoreStatus } from './shared-store.js';

export function getProtocolOrigin(): string {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (import.meta.env.DEV) {
      return `http://host.localhost:${DEV_PROTOCOL_PORT}`;
    }
    const port = window.location.port.length > 0 ? window.location.port : '5173';
    return `http://host.localhost:${port}`;
  }
  return `https://host.${BASE_DOMAIN}`;
}

export type ProtocolClientDeps = ProtocolFrameDeps;

/** The host page's side of the protocol frame. */
export interface ProtocolClient extends SharedStore, RemoteResolve, FrameTelemetry, RemoteChains {
  ensureProtocolFrame(): Promise<void>;
  getProtocolStatus(): ProtocolStatus;
  /** Called on each change only. Does not start a frame. */
  subscribeProtocolStatus(listener: (status: ProtocolStatus) => void): () => void;
  /**
   * Says what the frame is built with. Nothing boots before it, and requests made before the first config wait for
   * it up to a bound, so callers need not order themselves around the host's boot. The same config again does nothing. A different
   * one rebuilds a frame already asked for at once: its requests and ready waiters are rejected and its chain
   * connections halt as for a dead frame. A SharedWorker keeps its sync progress, only this tab's port cycles.
   */
  configureProtocolFrame(config: ProtocolFrameConfig): void;
}

export function createProtocolClient(deps: ProtocolClientDeps): ProtocolClient {
  // In this order, so a lost frame fails rpc requests before chains halt, and a halt carries that trail.
  const frame = createProtocolFrame(deps);
  const rpc = createFrameRpc(frame);
  const chains = createRemoteChains({ frame, rpc });
  const sharedStore = createSharedStore({ frame, rpc });
  return {
    ensureProtocolFrame: () => frame.whenUp('ready'),
    getProtocolStatus: () => frame.getStatus(),
    subscribeProtocolStatus: listener => frame.subscribeStatus(listener),
    configureProtocolFrame: config => {
      frame.configure(config);
    },
    ...sharedStore,
    ...createRemoteResolve(rpc),
    ...createFrameTelemetry(frame),
    ...chains,
  };
}

let defaultClient: ProtocolClient | null = null;

/** The page's one client, built on first use so a worker that imports this package never touches `window`. */
function getProtocolClient(): ProtocolClient {
  defaultClient ??= createProtocolClient({ origin: getProtocolOrigin(), document, window });
  return defaultClient;
}

export function ensureProtocolFrame(): Promise<void> {
  return getProtocolClient().ensureProtocolFrame();
}

export function getProtocolStatus(): ProtocolStatus {
  return getProtocolClient().getProtocolStatus();
}

export function configureProtocolFrame(config: ProtocolFrameConfig): void {
  getProtocolClient().configureProtocolFrame(config);
}

export function getSharedStoreStatus(): SharedStoreStatus {
  return getProtocolClient().getSharedStoreStatus();
}

export function subscribeSharedStoreStatus(listener: (status: SharedStoreStatus) => void): () => void {
  return getProtocolClient().subscribeSharedStoreStatus(listener);
}

export function getSmoldotDbOutcome(chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown' {
  return getProtocolClient().getSmoldotDbOutcome(chain);
}

export function warmupProtocol(): Promise<void> {
  return getProtocolClient().warmupProtocol();
}

export function resolveDotNameRemote(label: string, onPhase?: (phase: ResolvePhase) => void): Promise<string | null> {
  return getProtocolClient().resolveDotNameRemote(label, onPhase);
}

/**
 * Reads a name's owner through the protocol frame.
 * @public Kept with the frame's `resolveOwner` request, which pages embedding the frame may send, though no dotli page
 * calls it today.
 */
export function resolveOwnerRemote(label: string): Promise<string | null> {
  return getProtocolClient().resolveOwnerRemote(label);
}

export function resolveExecutableManifestRemote(
  label: string,
  kind: 'app' | 'widget' | 'worker',
): Promise<ManifestResult<ExecutableManifest>> {
  return getProtocolClient().resolveExecutableManifestRemote(label, kind);
}

export function resolveRootManifestRemote(label: string): Promise<ManifestResult<RootManifest>> {
  return getProtocolClient().resolveRootManifestRemote(label);
}

export function readSharedAuthStorage(siteId: SiteId, key: string): Promise<string | null> {
  return getProtocolClient().readSharedAuthStorage(siteId, key);
}

export function writeSharedAuthStorage(siteId: SiteId, key: string, value: string): Promise<void> {
  return getProtocolClient().writeSharedAuthStorage(siteId, key, value);
}

export function clearSharedAuthStorage(siteId: SiteId, key: string): Promise<void> {
  return getProtocolClient().clearSharedAuthStorage(siteId, key);
}

export function readSharedModeStorage(siteId: SiteId, key: string): Promise<string | null> {
  return getProtocolClient().readSharedModeStorage(siteId, key);
}

export function writeSharedModeStorage(siteId: SiteId, key: string, value: string): Promise<void> {
  return getProtocolClient().writeSharedModeStorage(siteId, key, value);
}

export function clearSharedModeStorage(siteId: SiteId, key: string): Promise<void> {
  return getProtocolClient().clearSharedModeStorage(siteId, key);
}

export function readSharedLocalWallet(siteId: SiteId): Promise<LocalWalletReadResult> {
  return getProtocolClient().readSharedLocalWallet(siteId);
}

export function saveSharedLocalWallet(siteId: SiteId, entropy: Uint8Array): Promise<void> {
  return getProtocolClient().saveSharedLocalWallet(siteId, entropy);
}

export function updateSharedLocalWalletIdentity(siteId: SiteId, identity: LocalWalletIdentity): Promise<void> {
  return getProtocolClient().updateSharedLocalWalletIdentity(siteId, identity);
}

export function forgetSharedLocalWallet(siteId: SiteId): Promise<void> {
  return getProtocolClient().forgetSharedLocalWallet(siteId);
}

export function subscribeSharedAuthStorage(listener: SharedAuthStorageListener): () => void {
  return getProtocolClient().subscribeSharedAuthStorage(listener);
}

export function onProtocolChainSync(listener: (event: ProtocolChainSyncEnvelope) => void): () => void {
  return getProtocolClient().onProtocolChainSync(listener);
}

export function onProtocolChainDetail(listener: (event: ProtocolChainDetailEnvelope) => void): () => void {
  return getProtocolClient().onProtocolChainDetail(listener);
}

export function onProtocolNetBytes(listener: (event: ProtocolNetBytesEnvelope) => void): () => void {
  return getProtocolClient().onProtocolNetBytes(listener);
}

export function createRemoteChainProvider(genesisHash: string): RemoteChainProvider | null {
  return getProtocolClient().createRemoteChainProvider(genesisHash);
}
