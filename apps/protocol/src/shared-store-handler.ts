// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the shared auth and mode stores and the local wallet to host pages, and other tabs' auth writes to the host
// pages that subscribe. The transport they are served on holds the shared-auth trust boundary: host and landing origins
// of this root domain, never product origins.

import { captureException } from '@dotli/metrics';
import { SITE_ID, type SiteId } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  protocolSchema,
  type LocalWalletRead,
  type SharedAuthChange,
  type ProtocolServing,
} from '@dotli/protocol';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWalletStore,
} from '@dotli/storage';
import { ok, type Failure, type ResultPayload, type Sink } from '@dotli/transport';

/** Each tab's iframe tells the other tabs' iframes of its shared-auth writes over this channel. */
export const SHARED_AUTH_CHANNEL = 'dotli:shared-auth';

/** What one tab's iframe tells the others when it writes a shared-auth key. */
interface SharedAuthBroadcastMessage {
  siteId: string;
  key: string;
  value: string | null;
}

/** The tabs' broadcast channel, as much of it as the store uses. A `BroadcastChannel` is one. */
export interface SharedAuthChannel {
  postMessage(message: SharedAuthBroadcastMessage): void;
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

export interface SharedStoreHandler {
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

function isBroadcastMessage(data: unknown): data is SharedAuthBroadcastMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'siteId' in data &&
    typeof data.siteId === 'string' &&
    'key' in data &&
    typeof data.key === 'string' &&
    'value' in data &&
    (data.value === null || typeof data.value === 'string')
  );
}

export function createSharedStoreHandler(serving: ProtocolServing, deps: SharedStoreDeps): SharedStoreHandler {
  const { channel } = deps;
  const subscribers = new Set<Sink<SharedAuthChange, undefined>>();

  function broadcast(siteId: string, key: string, value: string | null): void {
    if (channel === null) {
      return;
    }
    try {
      const message: SharedAuthBroadcastMessage = { siteId, key, value };
      channel.postMessage(message);
    } catch (error: unknown) {
      // The write was already made, so the host never hears other tabs missed it.
      captureException(error, { flow: 'storage', step: 'shared_auth_broadcast' });
    }
  }

  // BroadcastChannel skips the sender, whose adapter emits locally, so nothing is dispatched twice.
  function relay(event: { readonly data: unknown }): void {
    const { data } = event;
    // The site check is defensive, the channel is already origin-scoped.
    if (!isBroadcastMessage(data) || data.siteId !== SITE_ID) {
      return;
    }
    for (const sink of [...subscribers]) {
      sink.receive({ siteId: data.siteId, key: data.key, value: data.value });
    }
  }

  /**
   * Serves the `name` store, keyed by `build` once `isValidKey` passes. `onChange` hears each write and clear the store
   * made.
   */
  function serveStore(
    methods: StoreMethods,
    name: 'auth' | 'mode',
    isValidKey: (key: string) => boolean,
    build: (siteId: SiteId, key: string) => string,
    onChange: (siteId: string, key: string, value: string | null) => void = () => undefined,
  ): (() => void)[] {
    const keyed = <T>(payload: { siteId: string; key: string }, use: (key: string) => T) =>
      whenAdmitted(payload, site => {
        if (!isValidKey(payload.key)) {
          throw new Error(`Invalid shared ${name} key: ${payload.key}`);
        }
        return use(build(site, payload.key));
      });
    return [
      serving.handleRequest(methods.read, payload => keyed(payload, key => deps.storage().getItem(key))),
      serving.handleRequest(methods.write, payload =>
        keyed(payload, (key): undefined => {
          deps.storage().setItem(key, payload.value);
          onChange(payload.siteId, payload.key, payload.value);
        }),
      ),
      serving.handleRequest(methods.clear, payload =>
        keyed(payload, (key): undefined => {
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
      'auth',
      isValidSharedAuthKey,
      buildSharedAuthStorageKey,
      broadcast,
    ),
    ...serveStore(
      { read: storage.modeRead, write: storage.modeWrite, clear: storage.modeClear },
      'mode',
      isValidSharedModeKey,
      buildSharedModeStorageKey,
    ),
    serving.handleSubscription(storage.authChanges, (_start, _context, sink) => {
      subscribers.add(sink);
      return () => {
        subscribers.delete(sink);
      };
    }),
  ];

  return {
    stop: () => {
      channel?.removeEventListener('message', relay);
      for (const stop of unregister) {
        stop();
      }
    },
  };
}

const { wallet } = protocolSchema.sections;

const pageWallet: LocalWalletStore = { forgetLocalWallet, loadLocalWallet, saveLocalWallet, updateLocalWalletIdentity };

const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

function assertEntropy(value: Uint8Array): void {
  if (!ENTROPY_LENGTHS.has(value.length)) {
    throw new Error('Invalid local wallet entropy');
  }
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function read(store: LocalWalletStore): Promise<LocalWalletRead> {
  try {
    const wallet = await store.loadLocalWallet();
    return wallet === null
      ? { tag: 'none', value: undefined }
      : { tag: 'ok', value: { entropy: wallet.entropy, identity: wallet.identity } };
  } catch (error) {
    if (!(error instanceof LocalWalletUnreadableError)) {
      throw error;
    }
    await store.forgetLocalWallet();
    return { tag: 'unreadable', value: undefined };
  }
}

/** Serves the wallet to host pages on `serving`, over the page's own wallet store by default. */
export function serveLocalWallet(serving: ProtocolServing, store: LocalWalletStore = pageWallet): void {
  serving.handleRequest(wallet.read, payload => whenAdmitted(payload, () => read(store)));
  serving.handleRequest(wallet.save, payload =>
    whenAdmitted(payload, async (): Promise<undefined> => {
      assertEntropy(payload.entropy);
      await store.saveLocalWallet(payload.entropy);
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
    }),
  );
}
