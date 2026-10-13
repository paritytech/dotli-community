// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the shared auth and mode stores to host pages, and relays other tabs' auth writes to this tab's parent. Both
// stores keep the shared-auth trust boundary: host and landing origins of this root domain, never product origins.

import { captureException } from '@dotli/metrics';
import { SITE_ID, type SiteId } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from '@dotli/protocol';

import type { ResponseCallback } from './engine.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';

/** Each tab's iframe relays the other tabs' shared-auth writes to its parent over this channel. */
export const SHARED_AUTH_CHANNEL = 'dotli:shared-auth';

/** What one tab's iframe tells the others when it writes a shared-auth key. */
interface SharedAuthBroadcastMessage {
  siteId: SiteId;
  key: string;
  value: string | null;
}

/** The channel the iframes of every tab on this origin share. */
export type SharedAuthChannel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener'>;

export interface SharedStoreDeps {
  /** Read per request, because touching `localStorage` can throw where the browser blocks storage. */
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Null where the browser has no `BroadcastChannel`, so writes reach no other tab. */
  channel: SharedAuthChannel | null;
  /** The page that framed this iframe. Null when it is not framed. */
  parent: { postMessage: (message: ProtocolEnvelope, targetOrigin: string) => void } | null;
  /** The parent's origin from the referrer, until a request names it. Null under a strict referrer policy. */
  initialParentOrigin: string | null;
}

export type SharedStoreRequestHandler = (
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
) => void;

export interface SharedStoreHandler {
  /** Throws on a request it refuses, for the caller to answer as an error. */
  auth: SharedStoreRequestHandler;
  /** Throws on a request it refuses, for the caller to answer as an error. */
  mode: SharedStoreRequestHandler;
  /** Stops relaying other tabs' writes. */
  stop: () => void;
}

function assertSiteId(value: unknown): asserts value is SiteId {
  if (typeof value !== 'string' || !isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertAuthKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSharedAuthKey(value)) {
    throw new Error(`Invalid shared auth key: ${String(value)}`);
  }
}

function assertModeKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSharedModeKey(value)) {
    throw new Error(`Invalid shared mode key: ${String(value)}`);
  }
}

function assertOrigin(origin: string): void {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Shared auth request denied from origin: ${origin}`);
  }
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

function answer(respond: ResponseCallback, id: string, result: unknown): void {
  respond({ namespace: 'dotli:protocol', kind: 'response', id, ok: true, result });
}

export function createSharedStoreHandler(deps: SharedStoreDeps): SharedStoreHandler {
  const { channel, parent } = deps;
  // Broadcasts go only to a known parent origin, so unrelated embedders never hear them. Taken from every auth
  // request, in case the parent navigated.
  let parentOrigin = deps.initialParentOrigin;

  function broadcast(siteId: SiteId, key: string, value: string | null): void {
    if (channel === null) {
      return;
    }
    try {
      const message: SharedAuthBroadcastMessage = { siteId, key, value };
      channel.postMessage(message);
    } catch (error: unknown) {
      // The write was already answered, so the host never hears other tabs missed it.
      captureException(error, { flow: 'storage', step: 'shared_auth_broadcast' });
    }
  }

  // BroadcastChannel skips the sender, whose adapter emits locally, so nothing is dispatched twice.
  function relay(event: MessageEvent): void {
    const data: unknown = event.data;
    if (!isBroadcastMessage(data)) {
      return;
    }
    // Defensive, the channel is already origin-scoped.
    if (data.siteId !== SITE_ID) {
      return;
    }
    if (parentOrigin === null || parent === null) {
      return;
    }
    try {
      parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'auth-storage-changed',
          siteId: data.siteId,
          key: data.key,
          value: data.value,
        },
        parentOrigin,
      );
    } catch (error: unknown) {
      // Nothing waits on this notification, so the host never hears it was lost.
      captureException(error, { flow: 'storage', step: 'shared_auth_forward' });
    }
  }

  channel?.addEventListener('message', relay);

  function auth(request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback): void {
    if (!isSharedAuthRequestMethod(request.method)) {
      throw new Error(`Not a shared auth request: ${request.method}`);
    }
    assertOrigin(origin);
    parentOrigin = origin;

    switch (request.method) {
      case 'authStorageRead': {
        const payload = request.payload as ProtocolRequestMap['authStorageRead'];
        assertSiteId(payload.siteId);
        assertAuthKey(payload.key);
        answer(respond, request.id, deps.storage().getItem(buildSharedAuthStorageKey(payload.siteId, payload.key)));
        return;
      }

      case 'authStorageWrite': {
        const payload = request.payload as ProtocolRequestMap['authStorageWrite'];
        assertSiteId(payload.siteId);
        assertAuthKey(payload.key);
        if (typeof payload.value !== 'string') {
          throw new Error(PROTOCOL_APP_ERRORS.INVALID_SHARED_AUTH_VALUE);
        }
        deps.storage().setItem(buildSharedAuthStorageKey(payload.siteId, payload.key), payload.value);
        broadcast(payload.siteId, payload.key, payload.value);
        answer(respond, request.id, true);
        return;
      }

      case 'authStorageClear': {
        const payload = request.payload as ProtocolRequestMap['authStorageClear'];
        assertSiteId(payload.siteId);
        assertAuthKey(payload.key);
        deps.storage().removeItem(buildSharedAuthStorageKey(payload.siteId, payload.key));
        broadcast(payload.siteId, payload.key, null);
        answer(respond, request.id, true);
        return;
      }
    }
  }

  function mode(request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback): void {
    if (!isSharedModeRequestMethod(request.method)) {
      throw new Error(`Not a shared mode request: ${request.method}`);
    }
    assertOrigin(origin);

    switch (request.method) {
      case 'modeStorageRead': {
        const payload = request.payload as ProtocolRequestMap['modeStorageRead'];
        assertSiteId(payload.siteId);
        assertModeKey(payload.key);
        answer(respond, request.id, deps.storage().getItem(buildSharedModeStorageKey(payload.siteId, payload.key)));
        return;
      }

      case 'modeStorageWrite': {
        const payload = request.payload as ProtocolRequestMap['modeStorageWrite'];
        assertSiteId(payload.siteId);
        assertModeKey(payload.key);
        if (typeof payload.value !== 'string') {
          throw new Error(PROTOCOL_APP_ERRORS.INVALID_SHARED_MODE_VALUE);
        }
        deps.storage().setItem(buildSharedModeStorageKey(payload.siteId, payload.key), payload.value);
        answer(respond, request.id, true);
        return;
      }

      case 'modeStorageClear': {
        const payload = request.payload as ProtocolRequestMap['modeStorageClear'];
        assertSiteId(payload.siteId);
        assertModeKey(payload.key);
        deps.storage().removeItem(buildSharedModeStorageKey(payload.siteId, payload.key));
        answer(respond, request.id, true);
        return;
      }
    }
  }

  return {
    auth,
    mode,
    stop: () => {
      channel?.removeEventListener('message', relay);
    },
  };
}
