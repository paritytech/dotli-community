// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared store on `host.<BASE_DOMAIN>`: auth, mode preferences and the local wallet, one for every subdomain.

import type { SiteId } from '@dotli/config';
import { log } from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { protocolListeners } from './listeners.js';
import type { LocalWalletIdentity } from './messages.js';
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

export interface SharedStoreDeps {
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'whenUp' | 'onEnvelope'>;
  rpc: FrameRpc;
}

export function createSharedStore({ frame, rpc }: SharedStoreDeps) {
  const sharedAuthListeners = protocolListeners<SharedAuthStorageChange>('shared_auth');
  const statusListeners = protocolListeners<SharedStoreStatus>('shared_store_status');
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
      statusListeners.emit(store);
    }
  });

  frame.onEnvelope(msg => {
    if (msg.kind === 'auth-storage-changed') {
      sharedAuthListeners.emit({ siteId: msg.siteId, key: msg.key, value: msg.value });
    }
  });

  return {
    getSharedStoreStatus: getStatus,
    /** Called on each change only. */
    subscribeSharedStoreStatus: (listener: (status: SharedStoreStatus) => void) => statusListeners.subscribe(listener),
    readSharedAuthStorage: (siteId: SiteId, key: string) => rpc.request('authStorageRead', { siteId, key }),
    async writeSharedAuthStorage(siteId: SiteId, key: string, value: string): Promise<void> {
      await rpc.request('authStorageWrite', { siteId, key, value });
    },
    async clearSharedAuthStorage(siteId: SiteId, key: string): Promise<void> {
      await rpc.request('authStorageClear', { siteId, key });
    },
    /** Lives on `host.<BASE_DOMAIN>` so backend and cache preferences follow the user across subdomains. */
    readSharedModeStorage: (siteId: SiteId, key: string) => rpc.request('modeStorageRead', { siteId, key }),
    async writeSharedModeStorage(siteId: SiteId, key: string, value: string): Promise<void> {
      await rpc.request('modeStorageWrite', { siteId, key, value });
    },
    async clearSharedModeStorage(siteId: SiteId, key: string): Promise<void> {
      await rpc.request('modeStorageClear', { siteId, key });
    },
    /** The record lives on `host.<BASE_DOMAIN>`, so one import covers every app on the domain. */
    readSharedLocalWallet: (siteId: SiteId) => rpc.request('localWalletRead', { siteId }),
    async saveSharedLocalWallet(siteId: SiteId, entropy: Uint8Array): Promise<void> {
      await rpc.request('localWalletSave', { siteId, entropy });
    },
    async updateSharedLocalWalletIdentity(siteId: SiteId, identity: LocalWalletIdentity): Promise<void> {
      await rpc.request('localWalletIdentity', { siteId, identity });
    },
    async forgetSharedLocalWallet(siteId: SiteId): Promise<void> {
      await rpc.request('localWalletForget', { siteId });
    },
    /**
     * Hears shared-auth writes from sibling tabs of the same root domain, relayed by the host iframe
     * over `BroadcastChannel`. A tab's own writes do not arrive here.
     */
    subscribeSharedAuthStorage(listener: SharedAuthStorageListener): () => void {
      const unsubscribe = sharedAuthListeners.subscribe(listener);
      // Not awaited, since subscribe is synchronous. A frame that fails rebuilds itself.
      void frame.whenUp('listening').catch((error: unknown) => {
        log.warn('[dot.li protocol] Failed to ensure host frame for shared auth subscription:', error);
      });
      return unsubscribe;
    },
  };
}
