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
  type CallContext,
  type RequestHandler,
  type ServingTransport,
  type SubscriptionSink,
} from '@dotli/protocol';

import { OriginDeniedError } from './errors.js';

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

function assertOrigin(context: CallContext): void {
  if (context.origin === null || !isSharedAuthOriginAllowed(context.origin)) {
    throw new OriginDeniedError('Shared auth', context.origin);
  }
}

/** Checks a call's origin, site and auth key, and returns its storage key. */
function authKeyOf(payload: { siteId: string; key: string }, context: CallContext): string {
  assertOrigin(context);
  assertSiteId(payload.siteId);
  assertAuthKey(payload.key);
  return buildSharedAuthStorageKey(payload.siteId, payload.key);
}

/** Checks a call's origin, site and mode key, and returns its storage key. */
function modeKeyOf(payload: { siteId: string; key: string }, context: CallContext): string {
  assertOrigin(context);
  assertSiteId(payload.siteId);
  assertModeKey(payload.key);
  return buildSharedModeStorageKey(payload.siteId, payload.key);
}

function isBroadcastMessage(value: unknown): value is SharedAuthBroadcastMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as { siteId?: unknown; key?: unknown; value?: unknown };
  return (
    typeof obj.siteId === 'string' &&
    typeof obj.key === 'string' &&
    (obj.value === null || typeof obj.value === 'string')
  );
}

export function createSharedStoreHandler(serving: ServingTransport, deps: SharedStoreDeps): SharedStoreHandler {
  const { channel } = deps;
  const subscribers = new Set<SubscriptionSink<'sharedAuthChanges'>>();

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
  function relay(event: MessageEvent): void {
    const data: unknown = event.data;
    // The site check is defensive, the channel is already origin-scoped.
    if (!isBroadcastMessage(data) || data.siteId !== SITE_ID) {
      return;
    }
    for (const sink of [...subscribers]) {
      sink.send({ siteId: data.siteId, key: data.key, value: data.value });
    }
  }

  channel?.addEventListener('message', relay);

  const writeAuth: RequestHandler<'authStorageWrite'> = (payload, context) => {
    deps.storage().setItem(authKeyOf(payload, context), payload.value);
    broadcast(payload.siteId, payload.key, payload.value);
  };
  const clearAuth: RequestHandler<'authStorageClear'> = (payload, context) => {
    deps.storage().removeItem(authKeyOf(payload, context));
    broadcast(payload.siteId, payload.key, null);
  };
  const writeMode: RequestHandler<'modeStorageWrite'> = (payload, context) => {
    deps.storage().setItem(modeKeyOf(payload, context), payload.value);
  };
  const clearMode: RequestHandler<'modeStorageClear'> = (payload, context) => {
    deps.storage().removeItem(modeKeyOf(payload, context));
  };

  const unregister = [
    serving.handleRequest('authStorageRead', (payload, context) => deps.storage().getItem(authKeyOf(payload, context))),
    serving.handleRequest('authStorageWrite', writeAuth),
    serving.handleRequest('authStorageClear', clearAuth),
    serving.handleRequest('modeStorageRead', (payload, context) => deps.storage().getItem(modeKeyOf(payload, context))),
    serving.handleRequest('modeStorageWrite', writeMode),
    serving.handleRequest('modeStorageClear', clearMode),
    serving.handleSubscription('sharedAuthChanges', (_payload, context, sink) => {
      assertOrigin(context);
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
