// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared store on `host.<BASE_DOMAIN>`: auth, mode preferences and the local wallet, one for every subdomain.

import type { SiteId } from '@dotli/config';
import { log } from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { protocolListeners } from './listeners.js';
import type { LocalWalletIdentity, SharedAuthChange } from './methods.js';
import type { FrameRpc } from './rpc.js';
import type { ConsumerTransport, Subscription } from './transport.js';

export type SharedAuthStorageChange = SharedAuthChange;

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
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'transport'>;
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

  // The sibling tabs' auth changes, heard on the frame there is now while anyone listens.
  let changes: { transport: ConsumerTransport; subscription: Subscription } | null = null;
  // Each ask for a frame's transport, so an answer a later ask overtook is not followed.
  let asks = 0;

  function follow(transport: ConsumerTransport): void {
    if (sharedAuthListeners.size === 0 || changes?.transport === transport) {
      return;
    }
    changes?.subscription.unsubscribe();
    const subscription = transport.subscribe('sharedAuthChanges', undefined, change => {
      sharedAuthListeners.emit(change);
    });
    changes = { transport, subscription };
  }

  /** Follows the frame's transport. Asking for it boots a frame that is down, as a listener needs one. */
  function followFrame(): void {
    asks += 1;
    const ask = asks;
    void frame.transport().then(
      transport => {
        if (ask === asks) {
          follow(transport);
        }
      },
      (error: unknown) => {
        log.warn('[dot.li protocol] Failed to ensure host frame for shared auth subscription:', error);
      },
    );
  }

  let announced = getStatus();
  frame.subscribeStatus(next => {
    settledOnce ||= hasSettled(next);
    const store = getStatus();
    if (store !== announced) {
      announced = store;
      statusListeners.emit(store);
    }
    // A new frame relays nothing to a subscription on the one it replaces.
    if (next === 'booting' && sharedAuthListeners.size > 0) {
      followFrame();
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
      followFrame();
      return () => {
        unsubscribe();
        if (sharedAuthListeners.size === 0) {
          changes?.subscription.unsubscribe();
          changes = null;
        }
      };
    },
  };
}
