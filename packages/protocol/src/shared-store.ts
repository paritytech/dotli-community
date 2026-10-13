// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared store on `host.<BASE_DOMAIN>`: auth, mode preferences and the local wallet, one for every subdomain.

import type { SiteId } from '@dotli/config';
import { log } from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { addListener, broadcast } from './listeners.js';
import type { LocalWalletIdentity, LocalWalletReadResult } from './messages.js';
import type { FrameRpc } from './rpc.js';

export interface SharedAuthStorageChange {
  siteId: SiteId;
  key: string;
  value: string | null;
}

export type SharedAuthStorageListener = (change: SharedAuthStorageChange) => void;

/** Whether the shared store can answer. `connecting` until the first frame settles. */
export type SharedStoreStatus = 'connecting' | 'available' | 'unavailable';

/** A frame that listened, or failed to, settled the first wait. */
function hasSettled(status: ProtocolStatus): boolean {
  return status !== 'idle' && status !== 'booting';
}

/** The store answers once a frame listens. It stays `connecting` only until the first frame listens or fails. */
function sharedStoreStatusOf(status: ProtocolStatus, settledOnce: boolean): SharedStoreStatus {
  if (status === 'listening' || status === 'ready') {
    return 'available';
  }
  if (status === 'failed') {
    return 'unavailable';
  }
  return settledOnce ? 'unavailable' : 'connecting';
}

export interface SharedStore {
  getSharedStoreStatus(): SharedStoreStatus;
  /** Called on each change only. */
  subscribeSharedStoreStatus(listener: (status: SharedStoreStatus) => void): () => void;
  readSharedAuthStorage(siteId: SiteId, key: string): Promise<string | null>;
  writeSharedAuthStorage(siteId: SiteId, key: string, value: string): Promise<void>;
  clearSharedAuthStorage(siteId: SiteId, key: string): Promise<void>;
  /** Lives on `host.<BASE_DOMAIN>` so backend and cache preferences follow the user across subdomains. */
  readSharedModeStorage(siteId: SiteId, key: string): Promise<string | null>;
  writeSharedModeStorage(siteId: SiteId, key: string, value: string): Promise<void>;
  clearSharedModeStorage(siteId: SiteId, key: string): Promise<void>;
  /** The record lives on `host.<BASE_DOMAIN>`, so one import covers every app on the domain. */
  readSharedLocalWallet(siteId: SiteId): Promise<LocalWalletReadResult>;
  saveSharedLocalWallet(siteId: SiteId, entropy: Uint8Array): Promise<void>;
  updateSharedLocalWalletIdentity(siteId: SiteId, identity: LocalWalletIdentity): Promise<void>;
  forgetSharedLocalWallet(siteId: SiteId): Promise<void>;
  /**
   * Hears shared-auth writes from sibling tabs of the same root domain, relayed by the host iframe
   * over `BroadcastChannel`. A tab's own writes do not arrive here.
   */
  subscribeSharedAuthStorage(listener: SharedAuthStorageListener): () => void;
}

export interface SharedStoreDeps {
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'whenUp' | 'onEnvelope'>;
  rpc: FrameRpc;
}

export function createSharedStore({ frame, rpc }: SharedStoreDeps): SharedStore {
  const sharedAuthListeners = new Set<SharedAuthStorageListener>();
  const statusListeners = new Set<(status: SharedStoreStatus) => void>();
  // Latched from each status the frame publishes, since a listener ahead of this store's own can move the frame on
  // before this store reads it.
  let settledOnce = hasSettled(frame.getStatus());

  // Read from the frame's status on each call, so a frame status listener that runs before this store's own hears
  // the store as it is.
  function getStatus(): SharedStoreStatus {
    return sharedStoreStatusOf(frame.getStatus(), settledOnce);
  }

  let announced = getStatus();
  frame.subscribeStatus(next => {
    settledOnce ||= hasSettled(next);
    const store = getStatus();
    if (store !== announced) {
      announced = store;
      broadcast(statusListeners, store, 'Shared store status');
    }
  });

  frame.onEnvelope(msg => {
    if (msg.kind === 'auth-storage-changed') {
      broadcast(sharedAuthListeners, { siteId: msg.siteId, key: msg.key, value: msg.value }, 'Shared auth');
    }
  });

  return {
    getSharedStoreStatus: getStatus,
    subscribeSharedStoreStatus: listener => addListener(statusListeners, listener),
    async readSharedAuthStorage(siteId, key) {
      return (await rpc.request('authStorageRead', { siteId, key })) as string | null;
    },
    async writeSharedAuthStorage(siteId, key, value) {
      await rpc.request('authStorageWrite', { siteId, key, value });
    },
    async clearSharedAuthStorage(siteId, key) {
      await rpc.request('authStorageClear', { siteId, key });
    },
    async readSharedModeStorage(siteId, key) {
      return (await rpc.request('modeStorageRead', { siteId, key })) as string | null;
    },
    async writeSharedModeStorage(siteId, key, value) {
      await rpc.request('modeStorageWrite', { siteId, key, value });
    },
    async clearSharedModeStorage(siteId, key) {
      await rpc.request('modeStorageClear', { siteId, key });
    },
    async readSharedLocalWallet(siteId) {
      return (await rpc.request('localWalletRead', { siteId })) as LocalWalletReadResult;
    },
    async saveSharedLocalWallet(siteId, entropy) {
      await rpc.request('localWalletSave', { siteId, entropy });
    },
    async updateSharedLocalWalletIdentity(siteId, identity) {
      await rpc.request('localWalletIdentity', { siteId, identity });
    },
    async forgetSharedLocalWallet(siteId) {
      await rpc.request('localWalletForget', { siteId });
    },
    subscribeSharedAuthStorage(listener) {
      const unsubscribe = addListener(sharedAuthListeners, listener);
      // Not awaited, since subscribe is synchronous. A frame that fails rebuilds itself.
      void frame.whenUp('listening').catch((error: unknown) => {
        log.warn('[dot.li protocol] Failed to ensure host frame for shared auth subscription:', error);
      });
      return unsubscribe;
    },
  };
}
