// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the shared auth and mode stores to host pages, and other tabs' auth writes and wallet changes to the host
// pages that subscribe. The transport they are served on holds the shared-auth trust boundary: host and landing
// origins of this root domain, never product origins.

import { captureException, m, spans as S } from '@dotli/metrics';
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
import { getErrorName, log } from '@dotli/shared';
import type { Failure, ResultPayload, Sink } from '@dotli/transport';

import { answerAdmitted } from './answerAdmitted.js';

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
  /** The store's keys, which check the call's key and place it for the site. */
  keys: StoreKeys;
  /** The call, naming its site and key. */
  payload: { siteId: string; key: string };
  /** Answers with the call's stored key. What it throws fails the call. */
  use: (key: string) => T;
};

/** A shared auth key a tab wrote or cleared, as the other tabs hear it. */
type SessionChange = Extract<SharedAuthChange, { tag: 'session' }>['value'];

/** One store's read, write and clear. Both stores share their codecs, so they share these types. */
type StoreMethods = {
  read: typeof storageMethods.authRead;
  write: typeof storageMethods.authWrite;
  clear: typeof storageMethods.authClear;
};

/** One store's keys: which a call may name, and where each lives for a site. */
type StoreKeys = {
  /** The store's name, as its refusals say it. */
  name: 'auth' | 'mode';
  /** Whether a call may name the key. Never throws. */
  isValid: (key: string) => boolean;
  /** Where the key lives for the site. Never throws. */
  build: (siteId: SiteId, key: string) => string;
};

/**
 * Each tab's iframe tells the other tabs' iframes over this channel when it writes a shared-auth key or the local
 * wallet record changes.
 */
const SHARED_AUTH_CHANNEL = 'dotli:shared-auth';

const { storage: storageMethods } = protocolSchema.sections;

const AUTH_KEYS: StoreKeys = { name: 'auth', isValid: isValidSharedAuthKey, build: buildSharedAuthStorageKey };

const MODE_KEYS: StoreKeys = { name: 'mode', isValid: isValidSharedModeKey, build: buildSharedModeStorageKey };

/**
 * Serves the shared stores on `serving` and relays other tabs' changes until disposed. A call that fails is answered
 * with its failure.
 */
export function createSharedStoreHandler({ serving, readStorage, channel = openSharedAuthChannel() }: Params) {
  const subscribers = new Set<Sink<SharedAuthChange, SubscriptionEnd<undefined>>>();

  channel?.addEventListener('message', relay);

  const unregister = [
    ...serveStore(
      { read: storageMethods.authRead, write: storageMethods.authWrite, clear: storageMethods.authClear },
      AUTH_KEYS,
      { onChange: broadcastSession },
    ),
    // The read and the clear run in one task on the one store every tab's frame shares, which two calls from a page
    // could not do, so a value another tab wrote between them stays.
    serving.handleRequest(storageMethods.authClearIf, payload =>
      answerKeyed({
        keys: AUTH_KEYS,
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
    ...serveStore(
      { read: storageMethods.modeRead, write: storageMethods.modeWrite, clear: storageMethods.modeClear },
      MODE_KEYS,
    ),
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
      captureException(error, { flow: 'storage', step: 'shared_auth_broadcast' });
      log.error('[dot.li shared auth] Broadcast to the other tabs failed', error);
      m.count(S.PROTOCOL_SHARED_AUTH_BROADCAST, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
    }
  }

  function broadcastSession({ siteId, key, value }: SessionChange): void {
    broadcast({ tag: 'session', value: { siteId, key, value } });
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

  /** Serves the store under `keys`. */
  function serveStore(
    methods: StoreMethods,
    keys: StoreKeys,
    { onChange = (): void => undefined }: ServeStoreParams = {},
  ): (() => void)[] {
    return [
      serving.handleRequest(methods.read, payload =>
        answerKeyed({ keys, payload, use: key => readStorage().getItem(key) }),
      ),
      serving.handleRequest(methods.write, payload =>
        answerKeyed({
          keys,
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
      serving.handleRequest(methods.clear, payload =>
        answerKeyed({
          keys,
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

/** Answers with what `use` returns for the call's stored key once its site and key check. Either failing throws. */
function answerKeyed<T>({ keys, payload, use }: AnswerKeyedParams<T>): Promise<ResultPayload<T, Failure>> {
  return answerAdmitted(payload, site => {
    if (!keys.isValid(payload.key)) {
      throw new Error(`Invalid shared ${keys.name} key: ${payload.key}`);
    }
    return use(keys.build(site, payload.key));
  });
}

function isBroadcastMessage(data: unknown): data is SharedAuthChange {
  if (typeof data !== 'object' || data === null || !('tag' in data) || !('value' in data)) {
    return false;
  }
  const { value } = data;
  if (typeof value !== 'object' || value === null || !('siteId' in value) || typeof value.siteId !== 'string') {
    return false;
  }
  if (data.tag === 'wallet') {
    return true;
  }
  return (
    data.tag === 'session' &&
    'key' in value &&
    typeof value.key === 'string' &&
    'value' in value &&
    (value.value === null || typeof value.value === 'string')
  );
}
