// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared store in the protocol frame on `<BASE_DOMAIN>/__protocol/`: auth, mode preferences and the local wallet,
// one for every subdomain where the browser lets an embedded frame reach it, and one per top-level origin in Safari.

import type { SiteId } from '@dotli/config';
import { reportListener } from '@dotli/metrics';
import { createListenerSet, realTimers, type Timers } from '@dotli/shared';
import { createFeedKeeper } from './feed.js';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import type { FrameRpc } from './rpc.js';
import { protocolSchema, type LocalWalletIdentity, type LocalWalletRead, type SharedAuthChange } from './schema.js';
import { subscribe } from './subscription.js';

const { storage, wallet } = protocolSchema.sections;

export type SharedAuthStorageListener = (change: SharedAuthChange) => void;

/** `unreadable` means the frame found a record it could not decrypt, and has already deleted it. */
export type LocalWalletReadResult =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'ok'; entropy: Uint8Array; identity: LocalWalletIdentity | null; version: Uint8Array };

function localWalletReadResult(answer: LocalWalletRead): LocalWalletReadResult {
  switch (answer.tag) {
    case 'none':
      return { status: 'none' };
    case 'unreadable':
      return { status: 'unreadable' };
    case 'ok':
      return { status: 'ok', ...answer.value };
  }
}

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
  /** What a reopen of the auth change feed waits on. */
  timers?: Timers;
}

export function createSharedStore({ frame, rpc, timers = realTimers }: SharedStoreDeps) {
  const sharedAuthListeners = createListenerSet<SharedAuthChange>({
    onListenerError: reportListener('protocol', 'protocol.shared_auth'),
  });
  const statusListeners = createListenerSet<SharedStoreStatus>({
    onListenerError: reportListener('protocol', 'protocol.shared_store_status'),
  });
  // Latched from each status the frame publishes, since a listener ahead of this store's own can move the frame on
  // before this store reads it.
  let settledOnce = hasSettled(frame.getStatus());

  // Read from the frame's status on each call, so a frame status listener that runs before this store's own hears
  // the store as it is.
  function getStatus(): SharedStoreStatus {
    return sharedStoreStatusOf(frame.getStatus(), settledOnce);
  }

  // The sibling tabs' auth changes, heard on the frame there is now while anyone listens. Asking for its transport
  // boots a frame that is down, as a listener needs one.
  const changes = createFeedKeeper(
    'shared_auth',
    frame,
    transport => ends =>
      subscribe(transport, storage.authChanges, undefined, {
        receive: change => {
          sharedAuthListeners.emit(change);
        },
        ...ends,
      }),
    { boots: true, timers },
  );

  let announced = getStatus();
  frame.subscribeStatus(next => {
    settledOnce ||= hasSettled(next);
    const store = getStatus();
    if (store !== announced) {
      announced = store;
      statusListeners.emit(store);
    }
  });

  return {
    getSharedStoreStatus: getStatus,
    /** Called on each change only. */
    subscribeSharedStoreStatus: (listener: (status: SharedStoreStatus) => void) => statusListeners.subscribe(listener),
    readSharedAuthStorage: (siteId: SiteId, key: string) => rpc.request(storage.authRead, { siteId, key }),
    /** Resolves whether the value changed. An equal value is neither written nor told to other tabs. */
    writeSharedAuthStorage: (siteId: SiteId, key: string, value: string): Promise<boolean> =>
      rpc.request(storage.authWrite, { siteId, key, value }),
    async clearSharedAuthStorage(siteId: SiteId, key: string): Promise<void> {
      await rpc.request(storage.authClear, { siteId, key });
    },
    /**
     * Clears the key only while it still holds `expected`, in one step on the frame's store, so a value another tab
     * wrote since stays. Resolves whether it cleared it.
     */
    clearSharedAuthStorageIf: (siteId: SiteId, key: string, expected: string): Promise<boolean> =>
      rpc.request(storage.authClearIf, { siteId, key, value: expected }),
    /** Lives on `<BASE_DOMAIN>` so backend and cache preferences follow the user across subdomains. */
    readSharedModeStorage: (siteId: SiteId, key: string) => rpc.request(storage.modeRead, { siteId, key }),
    async writeSharedModeStorage(siteId: SiteId, key: string, value: string): Promise<void> {
      await rpc.request(storage.modeWrite, { siteId, key, value });
    },
    async clearSharedModeStorage(siteId: SiteId, key: string): Promise<void> {
      await rpc.request(storage.modeClear, { siteId, key });
    },
    /** The record lives on `<BASE_DOMAIN>`, so one import covers every app that reaches the main store. */
    async readSharedLocalWallet(siteId: SiteId): Promise<LocalWalletReadResult> {
      return localWalletReadResult(await rpc.request(wallet.read, { siteId }));
    },
    async saveSharedLocalWallet(
      siteId: SiteId,
      entropy: Uint8Array,
      identity: LocalWalletIdentity | null,
    ): Promise<void> {
      await rpc.request(wallet.save, { siteId, entropy, identity });
    },
    async updateSharedLocalWalletIdentity(siteId: SiteId, identity: LocalWalletIdentity): Promise<void> {
      await rpc.request(wallet.identity, { siteId, identity });
    },
    async forgetSharedLocalWallet(siteId: SiteId): Promise<void> {
      await rpc.request(wallet.forget, { siteId });
    },
    /**
     * Forgets the wallet only while it is still the record of `version`, as a read gave it, so a wallet saved since
     * stays. Resolves whether it did.
     */
    forgetSharedLocalWalletIf: (siteId: SiteId, version: Uint8Array): Promise<boolean> =>
      rpc.request(wallet.forgetIf, { siteId, version }),
    /**
     * Hears other tabs' session and local wallet changes on the same root domain, relayed by the protocol frame over
     * `BroadcastChannel`. A tab's own writes do not arrive here.
     */
    subscribeSharedAuthStorage(listener: SharedAuthStorageListener): () => void {
      const unsubscribe = sharedAuthListeners.subscribe(listener);
      changes.follow();
      return () => {
        unsubscribe();
        if (sharedAuthListeners.size === 0) {
          changes.stop();
        }
      };
    },
  };
}
