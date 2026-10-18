// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the shared auth and mode stores to host pages, and other tabs' auth writes to the host pages that subscribe.
// Both stores keep the shared-auth trust boundary: host and landing origins of this root domain, never product origins.

import { captureException } from '@dotli/metrics';
import { SITE_ID, type SiteId } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  protocolSchema,
  type ProtocolContext,
  type ProtocolServing,
} from '@dotli/protocol';
import { type CallError, denied, err, type MethodTypes, ok, type Result, type Sink } from '@dotli/transport';

/** Each tab's iframe tells the other tabs' iframes of its shared-auth writes over this channel. */
export const SHARED_AUTH_CHANNEL = 'dotli:shared-auth';

/** What one tab's iframe tells the others when it writes a shared-auth key. */
interface SharedAuthBroadcastMessage {
  siteId: string;
  key: string;
  value: string | null;
}

/** The channel the iframes of every tab on this origin share. */
export type SharedAuthChannel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener'>;

export interface SharedStoreDeps {
  /** Read per call, because touching `localStorage` can throw where the browser blocks storage. */
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Null where the browser has no `BroadcastChannel`, so writes reach no other tab. */
  channel: SharedAuthChannel | null;
}

const { storage } = protocolSchema.traits;

type SharedAuthChange = MethodTypes<typeof storage.authChanges>['receive'];

export interface SharedStoreHandler {
  /** Stops serving the stores and hearing other tabs. */
  stop: () => void;
}

function assertSiteId(value: string): asserts value is SiteId {
  if (!isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertAuthKey(value: string): void {
  if (!isValidSharedAuthKey(value)) {
    throw new Error(`Invalid shared auth key: ${value}`);
  }
}

function assertModeKey(value: string): void {
  if (!isValidSharedModeKey(value)) {
    throw new Error(`Invalid shared mode key: ${value}`);
  }
}

// Holds the shared-auth trust boundary on any transport these stores are served over.
function isOriginAllowed(context: ProtocolContext): boolean {
  return context.origin !== null && isSharedAuthOriginAllowed(context.origin);
}

/** A call's storage key once its site and key check, or the call's refusal when its origin may not use the store. */
function storeKey(
  payload: { siteId: string; key: string },
  context: ProtocolContext,
  assertKey: (key: string) => void,
  build: (siteId: SiteId, key: string) => string,
): Result<string, CallError<never>> {
  if (!isOriginAllowed(context)) {
    return err(denied());
  }
  assertSiteId(payload.siteId);
  assertKey(payload.key);
  return ok(build(payload.siteId, payload.key));
}

/** Checks a call's origin, site and auth key, and returns its storage key. */
function authKeyOf(
  payload: { siteId: string; key: string },
  context: ProtocolContext,
): Result<string, CallError<never>> {
  return storeKey(payload, context, assertAuthKey, buildSharedAuthStorageKey);
}

/** Checks a call's origin, site and mode key, and returns its storage key. */
function modeKeyOf(
  payload: { siteId: string; key: string },
  context: ProtocolContext,
): Result<string, CallError<never>> {
  return storeKey(payload, context, assertModeKey, buildSharedModeStorageKey);
}

/** Reads with the call's storage key, or answers the call's refusal. */
function readWith<T>(key: Result<string, CallError<never>>, read: (key: string) => T): Result<T, CallError<never>> {
  return key.tag === 'Ok' ? ok(read(key.value)) : key;
}

/** Writes with the call's storage key, or answers the call's refusal. */
function writeWith(
  key: Result<string, CallError<never>>,
  write: (key: string) => void,
): Result<undefined, CallError<never>> {
  if (key.tag === 'Err') {
    return key;
  }
  write(key.value);
  return ok();
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
  const subscribers = new Set<Sink<SharedAuthChange, never>>();

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
  function relay(event: MessageEvent<unknown>): void {
    const { data } = event;
    // The site check is defensive, the channel is already origin-scoped.
    if (!isBroadcastMessage(data) || data.siteId !== SITE_ID) {
      return;
    }
    for (const sink of [...subscribers]) {
      sink.receive({ siteId: data.siteId, key: data.key, value: data.value });
    }
  }

  channel?.addEventListener('message', relay);

  const unregister = [
    serving.handleRequest(storage.authRead, (payload, context) =>
      readWith(authKeyOf(payload, context), key => deps.storage().getItem(key)),
    ),
    serving.handleRequest(storage.authWrite, (payload, context) =>
      writeWith(authKeyOf(payload, context), key => {
        deps.storage().setItem(key, payload.value);
        broadcast(payload.siteId, payload.key, payload.value);
      }),
    ),
    serving.handleRequest(storage.authClear, (payload, context) =>
      writeWith(authKeyOf(payload, context), key => {
        deps.storage().removeItem(key);
        broadcast(payload.siteId, payload.key, null);
      }),
    ),
    serving.handleRequest(storage.modeRead, (payload, context) =>
      readWith(modeKeyOf(payload, context), key => deps.storage().getItem(key)),
    ),
    serving.handleRequest(storage.modeWrite, (payload, context) =>
      writeWith(modeKeyOf(payload, context), key => {
        deps.storage().setItem(key, payload.value);
      }),
    ),
    serving.handleRequest(storage.modeClear, (payload, context) =>
      writeWith(modeKeyOf(payload, context), key => {
        deps.storage().removeItem(key);
      }),
    ),
    serving.handleSubscription(storage.authChanges, (_start, context, sink) => {
      if (!isOriginAllowed(context)) {
        sink.interrupt(denied());
        return () => undefined;
      }
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
