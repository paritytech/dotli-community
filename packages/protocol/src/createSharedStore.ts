// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared store in the protocol frame on `<BASE_DOMAIN>/p/`: auth, mode preferences and the local wallet,
// one for every subdomain where the browser lets an embedded frame reach it, and one per top-level origin in Safari.

import { atom } from 'nanostores';
import type { SiteId } from '@dotli/config';
import { reportListener } from '@dotli/metrics';
import { createListenerSet, realTimers, type Timers } from '@dotli/shared';
import { createFeedKeeper } from './createFeedKeeper.js';
import type { FrameRpc } from './createFrameRpc.js';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import { protocolSchema, type LocalWalletIdentity, type LocalWalletRead, type SharedAuthChange } from './schema.js';
import { subscribe } from './subscribe.js';

export type SharedAuthListener = (change: SharedAuthChange) => void;

/** `unreadable` means the frame found a record it could not decrypt, and has already deleted it. */
export type LocalWalletReadResult =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'ok'; entropy: Uint8Array; identity: LocalWalletIdentity | null; version: Uint8Array };

/** Whether the shared store can answer. `connecting` until the first frame settles. */
export type SharedStoreStatus = 'connecting' | 'available' | 'unavailable';

type Params = {
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'getTransport'>;
  rpc: FrameRpc;
  /** What a reopen of the auth change feed waits on. */
  timers?: Timers;
};

type WriteParams = {
  siteId: SiteId;
  key: string;
  value: string;
};

type ClearIfParams = {
  siteId: SiteId;
  key: string;
  /** The value the key must still hold to be cleared. */
  expected: string;
};

type SaveParams = {
  siteId: SiteId;
  /** The recovery phrase's entropy. */
  entropy: Uint8Array;
  /** The wallet's cached identity, or null for none yet. */
  identity: LocalWalletIdentity | null;
};

const { storage, wallet: walletMethods } = protocolSchema.sections;

/**
 * The shared store in the frame as its status, auth, mode and wallet, each request on `rpc`, and its status from
 * `frame`'s.
 */
export function createSharedStore({ frame, rpc, timers = realTimers }: Params) {
  const sharedAuthListeners = createListenerSet<SharedAuthChange>({
    onListenerError: reportListener('protocol', 'protocol.shared_auth'),
  });
  // Latched from the status heard at each delivery, across rounds, since a listener ahead of this store's own can move
  // the frame on before this store reads it.
  let settledOnce = hasSettled(frame.getStatus());

  // Read from the frame's status on each call, so a frame status listener that runs before this store's own hears
  // the store as it is.
  function readStatus(): SharedStoreStatus {
    return deriveSharedStoreStatus(frame.getStatus(), settledOnce);
  }

  // The sibling tabs' auth changes, heard on the frame there is now while anyone listens. Asking for its transport
  // boots a frame that is down, as a listener needs one.
  const changes = createFeedKeeper({
    feed: 'shared_auth',
    frame,
    opener: transport => ends =>
      subscribe({
        transport,
        method: storage.authChanges,
        start: undefined,
        listeners: {
          receive: change => {
            sharedAuthListeners.emit(change);
          },
          ...ends,
        },
      }),
    boots: true,
    timers,
  });

  // The status last announced, which its listeners hear change.
  const announced = atom<SharedStoreStatus>(readStatus());
  frame.subscribeStatus(next => {
    settledOnce ||= hasSettled(next);
    announced.set(readStatus());
  });

  return {
    /** Whether the shared store can answer. */
    status: {
      /** The store's status now, read from the frame's. Never throws. */
      getStatus: readStatus,
      /**
       * Called on each change only, with the status there is when its turn comes, so within one round of listeners it
       * can hear the same status twice and miss one. Does not start a frame. Returns the unsubscribe.
       */
      subscribeStatus: (listener: (status: SharedStoreStatus) => void) =>
        announced.listen(next => {
          listener(next);
        }),
    },
    /** The auth store, shared by the sites on the same root domain. Each call reaches the frame. */
    auth: {
      /**
       * Resolves the value under `key` of `siteId`, or null when there is none. Rejects with a `ProtocolRequestError`
       * named after why the frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its
       * budget runs out, or with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with
       * a `PROTOCOL_ERRORS` text.
       */
      read: (siteId: SiteId, key: string) => rpc.request(storage.authRead, { siteId, key }),
      /**
       * Resolves whether the value changed. An equal value is neither written nor told to other tabs. Rejects with a
       * `ProtocolRequestError` named after why the frame failed the call, or a `ProtocolRequestError` named
       * `ProtocolTimeoutError` once its budget runs out, or with the error the frame went down with, such as a
       * `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS` text.
       */
      write: ({ siteId, key, value }: WriteParams): Promise<boolean> =>
        rpc.request(storage.authWrite, { siteId, key, value }),
      /**
       * Resolves once `key` of `siteId` is gone. Rejects with a `ProtocolRequestError` named after why the frame failed
       * the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or with the error
       * the frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS` text.
       */
      async clear(siteId: SiteId, key: string): Promise<void> {
        await rpc.request(storage.authClear, { siteId, key });
      },
      /**
       * Clears the key only while it still holds `expected`, in one step on the frame's store, so a value another tab
       * wrote since stays. Resolves whether it cleared it. Rejects with a `ProtocolRequestError` named after why the
       * frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or
       * with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS`
       * text.
       */
      clearIf: ({ siteId, key, expected }: ClearIfParams): Promise<boolean> =>
        rpc.request(storage.authClearIf, { siteId, key, value: expected }),
      /**
       * Hears other tabs' session and local wallet changes on the same root domain, relayed by the protocol frame over
       * `BroadcastChannel`. A tab's own writes do not arrive here. The first listener boots a frame that is down.
       * Returns the unsubscribe, and the last one to leave stops the feed.
       */
      subscribe(listener: SharedAuthListener): () => void {
        const unsubscribe = sharedAuthListeners.subscribe(listener);
        changes.follow();
        function unsubscribeAuthChanges(): void {
          unsubscribe();
          if (sharedAuthListeners.size === 0) {
            changes.stop();
          }
        }
        return unsubscribeAuthChanges;
      },
    },
    /**
     * The mode store, on `<BASE_DOMAIN>` so backend and cache preferences follow the user across subdomains. Each call
     * reaches the frame.
     */
    mode: {
      /**
       * Resolves the value under `key` of `siteId`, or null when there is none. Rejects with a `ProtocolRequestError`
       * named after why the frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its
       * budget runs out, or with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with
       * a `PROTOCOL_ERRORS` text.
       */
      read: (siteId: SiteId, key: string) => rpc.request(storage.modeRead, { siteId, key }),
      /**
       * Resolves once `value` is stored under `key` of `siteId`. Rejects with a `ProtocolRequestError` named after why
       * the frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out,
       * or with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a
       * `PROTOCOL_ERRORS` text.
       */
      async write({ siteId, key, value }: WriteParams): Promise<void> {
        await rpc.request(storage.modeWrite, { siteId, key, value });
      },
      /**
       * Resolves once `key` of `siteId` is gone. Rejects with a `ProtocolRequestError` named after why the frame failed
       * the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or with the error
       * the frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS` text.
       */
      async clear(siteId: SiteId, key: string): Promise<void> {
        await rpc.request(storage.modeClear, { siteId, key });
      },
    },
    /**
     * The local wallet record of each site. It lives on `<BASE_DOMAIN>`, so one import covers every app that reaches
     * the main store. Each call reaches the frame.
     */
    wallet: {
      /**
       * Resolves the site's record as the frame read it. Rejects with a `ProtocolRequestError` named after why the
       * frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or
       * with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS`
       * text.
       */
      async read(siteId: SiteId): Promise<LocalWalletReadResult> {
        return toLocalWalletReadResult(await rpc.request(walletMethods.read, { siteId }));
      },
      /**
       * Resolves once the record is saved with `identity`. Rejects with a `ProtocolRequestError` named after why the
       * frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or
       * with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS`
       * text.
       */
      async save({ siteId, entropy, identity }: SaveParams): Promise<void> {
        await rpc.request(walletMethods.save, { siteId, entropy, identity });
      },
      /**
       * Resolves once the record's cached identity is `identity`. Rejects with a `ProtocolRequestError` named after why
       * the frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out,
       * or with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a
       * `PROTOCOL_ERRORS` text.
       */
      async updateIdentity(siteId: SiteId, identity: LocalWalletIdentity): Promise<void> {
        await rpc.request(walletMethods.identity, { siteId, identity });
      },
      /**
       * Resolves once the site's record is gone. Rejects with a `ProtocolRequestError` named after why the frame failed
       * the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or with the error
       * the frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS` text.
       */
      async forget(siteId: SiteId): Promise<void> {
        await rpc.request(walletMethods.forget, { siteId });
      },
      /**
       * Forgets the wallet only while it is still the record of `version`, as a read gave it, so a wallet saved since
       * stays. Resolves whether it did. Rejects with a `ProtocolRequestError` named after why the frame failed the
       * call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out, or with the error the
       * frame went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS` text.
       */
      forgetIf: (siteId: SiteId, version: Uint8Array): Promise<boolean> =>
        rpc.request(walletMethods.forgetIf, { siteId, version }),
    },
  };
}

function toLocalWalletReadResult(answer: LocalWalletRead): LocalWalletReadResult {
  switch (answer.tag) {
    case 'none':
      return { status: 'none' };
    case 'unreadable':
      return { status: 'unreadable' };
    case 'ok':
      return { status: 'ok', ...answer.value };
  }
}

/** A frame that listened, or failed to, settled the first wait. */
function hasSettled(status: ProtocolStatus): boolean {
  switch (status) {
    case 'listening':
    case 'ready':
    case 'failed':
      return true;
    case 'idle':
    case 'booting':
      return false;
  }
}

/** The store answers once a frame listens. It stays `connecting` only until the first frame listens or fails. */
function deriveSharedStoreStatus(status: ProtocolStatus, settledOnce: boolean): SharedStoreStatus {
  switch (status) {
    case 'listening':
    case 'ready':
      return 'available';
    case 'failed':
      return 'unavailable';
    case 'idle':
    case 'booting':
      return settledOnce ? 'unavailable' : 'connecting';
  }
}
