// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the shared auth and mode stores and the local wallet to host pages, and other tabs' auth writes and wallet
// changes to the host pages that subscribe. The transport they are served on holds the shared-auth trust boundary: host
// and landing origins of this root domain, never product origins.

import { captureException } from '@dotli/metrics';
import { SITE_ID, type SiteId } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isLocalWalletEntropy,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  protocolSchema,
  type LocalWalletRead,
  type SharedAuthChange,
  type ProtocolServing,
  type SubscriptionEnd,
} from '@dotli/protocol';
import {
  forgetLocalWallet,
  forgetLocalWalletIf,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWalletStore,
} from '@dotli/storage';
import { ok, type Failure, type ResultPayload, type Sink } from '@dotli/transport';

/**
 * Each tab's iframe tells the other tabs' iframes over this channel when it writes a shared-auth key or the local
 * wallet record changes.
 */
export const SHARED_AUTH_CHANNEL = 'dotli:shared-auth';

/** The tabs' broadcast channel, as much of it as the store uses. A `BroadcastChannel` is one. */
export interface SharedAuthChannel {
  postMessage(message: SharedAuthChange): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

export interface SharedStoreDeps {
  /** Read per call, because touching `localStorage` can throw where the browser blocks storage. */
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Null where the browser has no `BroadcastChannel`, so writes reach no other tab. */
  channel: SharedAuthChannel | null;
}

const { storage } = protocolSchema.sections;

/** One store's read, write and clear. Both stores share their codecs, so they share these types. */
interface StoreMethods {
  read: typeof storage.authRead;
  write: typeof storage.authWrite;
  clear: typeof storage.authClear;
}

/** One store's keys: which a call may name, and where each lives for a site. */
interface StoreKeys {
  name: 'auth' | 'mode';
  isValid: (key: string) => boolean;
  build: (siteId: SiteId, key: string) => string;
}

const AUTH_KEYS: StoreKeys = { name: 'auth', isValid: isValidSharedAuthKey, build: buildSharedAuthStorageKey };

const MODE_KEYS: StoreKeys = { name: 'mode', isValid: isValidSharedModeKey, build: buildSharedModeStorageKey };

export interface SharedStoreHandler {
  /** Tells the other tabs the local wallet record of `siteId` changed, on the auth relay as a tagged wallet change. */
  walletChanged: (siteId: string) => void;
  /** Stops serving the stores and hearing other tabs. */
  stop: () => void;
}

/** Answers with what `run` returns for the call's site once it checks. A site that does not check throws. */
async function whenAdmitted<T>(
  payload: { siteId: string },
  run: (site: SiteId) => T | Promise<T>,
): Promise<ResultPayload<T, Failure>> {
  if (!isSharedAuthSiteId(payload.siteId)) {
    throw new Error(`Invalid siteId: ${String(payload.siteId)}`);
  }
  return ok(await run(payload.siteId));
}

/** Answers with what `use` returns for the call's stored key once its site and key check. Either failing throws. */
function whenKeyed<T>(
  keys: StoreKeys,
  payload: { siteId: string; key: string },
  use: (key: string) => T,
): Promise<ResultPayload<T, Failure>> {
  return whenAdmitted(payload, site => {
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

export function createSharedStoreHandler(serving: ProtocolServing, deps: SharedStoreDeps): SharedStoreHandler {
  const { channel } = deps;
  const subscribers = new Set<Sink<SharedAuthChange, SubscriptionEnd<undefined>>>();

  function broadcast(message: SharedAuthChange): void {
    if (channel === null) {
      return;
    }
    try {
      channel.postMessage(message);
    } catch (error: unknown) {
      // The write was already made, so the host never hears other tabs missed it.
      captureException(error, { flow: 'storage', step: 'shared_auth_broadcast' });
    }
  }

  function broadcastSession(siteId: string, key: string, value: string | null): void {
    broadcast({ tag: 'session', value: { siteId, key, value } });
  }

  // BroadcastChannel skips the sender, whose adapter emits locally, so nothing is dispatched twice.
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

  /** Serves the store under `keys`. `onChange` hears each write and clear the store made. */
  function serveStore(
    methods: StoreMethods,
    keys: StoreKeys,
    onChange: (siteId: string, key: string, value: string | null) => void = () => undefined,
  ): (() => void)[] {
    return [
      serving.handleRequest(methods.read, payload => whenKeyed(keys, payload, key => deps.storage().getItem(key))),
      serving.handleRequest(methods.write, payload =>
        whenKeyed(keys, payload, key => {
          const storage = deps.storage();
          // An equal value is left alone, so no other tab's cores wake for nothing.
          if (storage.getItem(key) === payload.value) {
            return false;
          }
          storage.setItem(key, payload.value);
          onChange(payload.siteId, payload.key, payload.value);
          return true;
        }),
      ),
      serving.handleRequest(methods.clear, payload =>
        whenKeyed(keys, payload, (key): undefined => {
          deps.storage().removeItem(key);
          onChange(payload.siteId, payload.key, null);
        }),
      ),
    ];
  }

  channel?.addEventListener('message', relay);

  const unregister = [
    ...serveStore(
      { read: storage.authRead, write: storage.authWrite, clear: storage.authClear },
      AUTH_KEYS,
      broadcastSession,
    ),
    // The read and the clear run in one task on the one store every tab's frame shares, which two calls from a page
    // could not do, so a value another tab wrote between them stays.
    serving.handleRequest(storage.authClearIf, payload =>
      whenKeyed(AUTH_KEYS, payload, key => {
        const store = deps.storage();
        if (store.getItem(key) !== payload.value) {
          return false;
        }
        store.removeItem(key);
        broadcastSession(payload.siteId, payload.key, null);
        return true;
      }),
    ),
    ...serveStore({ read: storage.modeRead, write: storage.modeWrite, clear: storage.modeClear }, MODE_KEYS),
    serving.handleSubscription(storage.authChanges, (_start, _context, sink) => {
      subscribers.add(sink);
      return () => {
        subscribers.delete(sink);
      };
    }),
  ];

  return {
    walletChanged: siteId => {
      broadcast({ tag: 'wallet', value: { siteId } });
    },
    stop: () => {
      channel?.removeEventListener('message', relay);
      for (const stop of unregister) {
        stop();
      }
    },
  };
}

const { wallet } = protocolSchema.sections;

const pageWallet: LocalWalletStore = {
  forgetLocalWallet,
  forgetLocalWalletIf,
  loadLocalWallet,
  saveLocalWallet,
  updateLocalWalletIdentity,
};

function assertEntropy(value: Uint8Array): void {
  if (!isLocalWalletEntropy(value)) {
    throw new Error('Invalid local wallet entropy');
  }
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function read(store: LocalWalletStore): Promise<LocalWalletRead> {
  try {
    const wallet = await store.loadLocalWallet();
    return wallet === null
      ? { tag: 'none', value: undefined }
      : { tag: 'ok', value: { entropy: wallet.entropy, identity: wallet.identity, version: wallet.version } };
  } catch (error) {
    if (!(error instanceof LocalWalletUnreadableError)) {
      throw error;
    }
    await store.forgetLocalWallet();
    return { tag: 'unreadable', value: undefined };
  }
}

/**
 * Serves the wallet to host pages on `serving`, over the page's own wallet store by default. `changed` hears each save
 * and forget, and each compare-and-forget that forgot, so other tabs on the wallet learn it went. An identity is the
 * same wallet, and an unreadable record a read drops was already lost to every tab.
 */
export function serveLocalWallet(
  serving: ProtocolServing,
  changed: (siteId: string) => void,
  store: LocalWalletStore = pageWallet,
): void {
  serving.handleRequest(wallet.read, payload => whenAdmitted(payload, () => read(store)));
  serving.handleRequest(wallet.save, payload =>
    whenAdmitted(payload, async (): Promise<undefined> => {
      assertEntropy(payload.entropy);
      await store.saveLocalWallet(payload.entropy, payload.identity);
      changed(payload.siteId);
    }),
  );
  serving.handleRequest(wallet.identity, payload =>
    whenAdmitted(payload, async (): Promise<undefined> => {
      await store.updateLocalWalletIdentity(payload.identity);
    }),
  );
  serving.handleRequest(wallet.forget, payload =>
    whenAdmitted(payload, async (): Promise<undefined> => {
      await store.forgetLocalWallet();
      changed(payload.siteId);
    }),
  );
  serving.handleRequest(wallet.forgetIf, payload =>
    whenAdmitted(payload, async () => {
      const forgot = await store.forgetLocalWalletIf(payload.version);
      if (forgot) {
        changed(payload.siteId);
      }
      return forgot;
    }),
  );
}
