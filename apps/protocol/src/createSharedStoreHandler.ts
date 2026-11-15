// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the shared auth and mode stores to host pages, and other tabs' auth writes and wallet changes to the host
// pages that subscribe. The transport they are served on holds the shared-auth trust boundary: host and landing
// origins of this root domain, never product origins.

import { createReporter, defineCount } from '@dotli/metrics';
import { SITE_ID, type SiteId } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  protocolSchema,
  type SharedAuthChange,
  type ProtocolServing,
  type SubscriptionEnd,
} from '@dotli/protocol';
import { isRecord } from '@dotli/shared';
import type { Failure, ResultPayload, Sink } from '@dotli/transport';

import { answerAdmitted } from './answerAdmitted.js';
import { InvalidInputError } from './invalidInputError.js';

const report = createReporter({ flow: 'storage' });

/**
 * A shared auth or wallet change the protocol frame could not post to the other tabs, tagged `outcome` (error) and
 * `reason` (the error's name).
 */
const protocolSharedAuthBroadcastMetric = defineCount<'error'>('protocol.shared_auth_broadcast');

/** The tabs' broadcast channel, as much of it as the store uses. A `BroadcastChannel` is one. */
export type SharedAuthChannel = {
  /** Posts to the other tabs. Throws when the message cannot be cloned or the channel is closed. */
  postMessage(message: SharedAuthChange): void;
  /** Hears each message another tab posts. Never throws. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Stops hearing other tabs through `listener`. Never throws. */
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
};

type Params = {
  /** Where the stores are served. */
  serving: ProtocolServing;
  /** Read per call, because touching `localStorage` can throw where the browser blocks storage. */
  readStorage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /**
   * The tabs' channel. Defaults to a `BroadcastChannel` on `SHARED_AUTH_CHANNEL`, or to null where the browser has
   * none. With null, a write reaches no other tab.
   */
  channel?: SharedAuthChannel | null;
};

type ServeStoreParams = {
  /** Hears each write and clear the store made. */
  onChange?: (change: SessionChange) => void;
};

type AnswerKeyedParams<T> = {
  /** The store, whose keys check the call's key and place it for the site. */
  store: StoreKeys;
  /** The call, naming its site and key. */
  payload: { siteId: string; key: string };
  /** Answers with the call's stored key. What it throws fails the call. */
  use: (key: string) => T;
};

/** A shared auth key a tab wrote or cleared, as the other tabs hear it. */
type SessionChange = Extract<SharedAuthChange, { tag: 'session' }>['value'];

/** One store's keys: which a call may name, and where each lives for a site. */
type StoreKeys = {
  /** The store's name, as its refusals say it. */
  name: 'auth' | 'mode';
  /** Whether a call may name the key. Never throws. */
  isValid: (key: string) => boolean;
  /** Where the key lives for the site. Never throws. */
  build: (siteId: SiteId, key: string) => string;
};

/** One store: its keys, and the methods that read, write and clear it. Both stores share their codecs, so their types. */
type Store = StoreKeys & {
  read: typeof storageMethods.authRead;
  write: typeof storageMethods.authWrite;
  clear: typeof storageMethods.authClear;
};

/**
 * Each tab's iframe tells the other tabs' iframes over this channel when it writes a shared-auth key or the local
 * wallet record changes.
 */
const SHARED_AUTH_CHANNEL = 'dotli:shared-auth';

const { storage: storageMethods } = protocolSchema.sections;

const AUTH_STORE: Store = {
  name: 'auth',
  isValid: isValidSharedAuthKey,
  build: buildSharedAuthStorageKey,
  read: storageMethods.authRead,
  write: storageMethods.authWrite,
  clear: storageMethods.authClear,
};

const MODE_STORE: Store = {
  name: 'mode',
  isValid: isValidSharedModeKey,
  build: buildSharedModeStorageKey,
  read: storageMethods.modeRead,
  write: storageMethods.modeWrite,
  clear: storageMethods.modeClear,
};

/**
 * Serves the shared stores on `serving` and relays other tabs' changes until disposed. A call that fails is answered
 * with its failure.
 */
export function createSharedStoreHandler({ serving, readStorage, channel = openSharedAuthChannel() }: Params) {
  const subscribers = new Set<Sink<SharedAuthChange, SubscriptionEnd<undefined>>>();

  channel?.addEventListener('message', relay);

  const unregister = [
    ...serveStore(AUTH_STORE, { onChange: broadcastSession }),
    // The read and the clear run in one task on the one store every tab's frame shares, which two calls from a page
    // could not do, so a value another tab wrote between them stays.
    serving.handleRequest(storageMethods.authClearIf, payload =>
      answerKeyed({
        store: AUTH_STORE,
        payload,
        use(key) {
          const store = readStorage();
          if (store.getItem(key) !== payload.value) {
            return false;
          }
          store.removeItem(key);
          broadcastSession({ siteId: payload.siteId, key: payload.key, value: null });
          return true;
        },
      }),
    ),
    ...serveStore(MODE_STORE),
    serving.handleSubscription(storageMethods.authChanges, (_start, _context, sink) => {
      subscribers.add(sink);
      return () => {
        subscribers.delete(sink);
      };
    }),
  ];

  return {
    /**
     * Tells the other tabs the local wallet record of `siteId` changed, on the auth relay as a tagged wallet change.
     * Never throws: a failed broadcast is reported.
     */
    broadcastWalletChange,
    /** Stops serving the stores and hearing other tabs. Never throws. */
    dispose,
  };

  function broadcast(message: SharedAuthChange): void {
    if (channel === null) {
      return;
    }
    try {
      channel.postMessage(message);
    } catch (error: unknown) {
      // The write was already made, so the host never hears other tabs missed it.
      report.defect(error, {
        step: 'shared_auth_broadcast',
        metric: protocolSharedAuthBroadcastMetric,
        message: '[dot.li shared auth] Broadcast to the other tabs failed',
      });
    }
  }

  function broadcastSession(change: SessionChange): void {
    broadcast({ tag: 'session', value: change });
  }

  // BroadcastChannel skips the sender, so a tab never hears its own write here.
  function relay(event: { readonly data: unknown }): void {
    const { data } = event;
    // The site check is defensive, the channel is already origin-scoped.
    if (!isBroadcastMessage(data) || data.value.siteId !== SITE_ID) {
      return;
    }
    for (const sink of [...subscribers]) {
      sink.send(data);
    }
  }

  /** Serves `store`'s read, write and clear. */
  function serveStore(store: Store, { onChange = (): void => undefined }: ServeStoreParams = {}): (() => void)[] {
    return [
      serving.handleRequest(store.read, payload =>
        answerKeyed({ store, payload, use: key => readStorage().getItem(key) }),
      ),
      serving.handleRequest(store.write, payload =>
        answerKeyed({
          store,
          payload,
          use(key) {
            const store = readStorage();
            // An equal value is left alone and tells no other tab.
            if (store.getItem(key) === payload.value) {
              return false;
            }
            store.setItem(key, payload.value);
            onChange({ siteId: payload.siteId, key: payload.key, value: payload.value });
            return true;
          },
        }),
      ),
      serving.handleRequest(store.clear, payload =>
        answerKeyed({
          store,
          payload,
          use(key): undefined {
            readStorage().removeItem(key);
            onChange({ siteId: payload.siteId, key: payload.key, value: null });
          },
        }),
      ),
    ];
  }

  function broadcastWalletChange(siteId: string): void {
    broadcast({ tag: 'wallet', value: { siteId } });
  }

  function dispose(): void {
    channel?.removeEventListener('message', relay);
    for (const unregisterOne of unregister) {
      unregisterOne();
    }
  }
}

/** Opens the tabs' shared-auth channel, or returns null where the browser has no `BroadcastChannel`. */
function openSharedAuthChannel(): SharedAuthChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(SHARED_AUTH_CHANNEL);
}

/**
 * Answers with what `use` returns for the call's stored key once its site and key check. Rejects with an
 * `InvalidInputError` when either does not check, and with what `use` throws.
 */
function answerKeyed<T>({ store, payload, use }: AnswerKeyedParams<T>): Promise<ResultPayload<T, Failure>> {
  return answerAdmitted(payload, site => {
    if (!store.isValid(payload.key)) {
      throw new InvalidInputError(`Invalid shared ${store.name} key: ${payload.key}`);
    }
    return use(store.build(site, payload.key));
  });
}

function isBroadcastMessage(data: unknown): data is SharedAuthChange {
  if (!isRecord(data)) {
    return false;
  }
  const { tag, value } = data;
  if (!isRecord(value) || typeof value['siteId'] !== 'string') {
    return false;
  }
  switch (tag) {
    case 'wallet':
      return true;
    case 'session':
      return typeof value['key'] === 'string' && (value['value'] === null || typeof value['value'] === 'string');
    default:
      // Another tab's message is unknown data, so any other tag is no change.
      return false;
  }
}
