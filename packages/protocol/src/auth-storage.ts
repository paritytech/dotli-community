// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, SITE_ID, type SiteId } from '@dotli/config';
import type { ProtocolRequestMethod } from './messages.js';

export type SharedAuthRequestMethod = 'authStorageRead' | 'authStorageWrite' | 'authStorageClear';

export type SharedModeRequestMethod = 'modeStorageRead' | 'modeStorageWrite' | 'modeStorageClear';

export const SHARED_CORE_SESSION_KEY = 'session';

const SHARED_STORAGE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_AUTH_METHODS = new Set<ProtocolRequestMethod>(['authStorageRead', 'authStorageWrite', 'authStorageClear']);
const SHARED_MODE_METHODS = new Set<ProtocolRequestMethod>(['modeStorageRead', 'modeStorageWrite', 'modeStorageClear']);

export function isSharedAuthRequestMethod(method: ProtocolRequestMethod): method is SharedAuthRequestMethod {
  return SHARED_AUTH_METHODS.has(method);
}

export function isSharedModeRequestMethod(method: ProtocolRequestMethod): method is SharedModeRequestMethod {
  return SHARED_MODE_METHODS.has(method);
}

export type SharedWalletRequestMethod =
  'localWalletRead' | 'localWalletSave' | 'localWalletIdentity' | 'localWalletForget';

const SHARED_WALLET_METHODS = new Set<ProtocolRequestMethod>([
  'localWalletRead',
  'localWalletSave',
  'localWalletIdentity',
  'localWalletForget',
]);

export function isSharedWalletRequestMethod(method: ProtocolRequestMethod): method is SharedWalletRequestMethod {
  return SHARED_WALLET_METHODS.has(method);
}

/**
 * Sessions are scoped to the root domain the shell runs on, so a host accepts only its own `SITE_ID`.
 * No allowlist, so unrelated roots never share sessions and new deployment domains need no change.
 */
export function isSharedAuthSiteId(value: string): value is SiteId {
  return value === SITE_ID;
}

/** Checks the raw caller key, not the namespaced `buildSharedAuthStorageKey` form. */
export function isValidSharedAuthKey(key: string): boolean {
  return SHARED_STORAGE_KEY_PATTERN.test(key);
}

export function buildSharedAuthStorageKey(siteId: SiteId, key: string): string {
  return `TRUAPI_${siteId}_${key}`;
}

/** A prefix distinct from auth's so the two stores cannot collide. */
export function buildSharedModeStorageKey(siteId: SiteId, key: string): string {
  return `DOTLI_MODE_${siteId}_${key}`;
}

/** Checks the raw caller key, not the namespaced `buildSharedModeStorageKey` form. */
export function isValidSharedModeKey(key: string): boolean {
  return SHARED_STORAGE_KEY_PATTERN.test(key);
}

export function isSharedAuthOriginAllowed(origin: string): boolean {
  try {
    const url = new URL(origin);
    const { hostname, protocol } = url;

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return hostname !== 'app.localhost' && !hostname.endsWith('.app.localhost');
    }

    if (protocol !== 'https:') {
      return false;
    }

    if (hostname === BASE_DOMAIN || hostname === `host.${BASE_DOMAIN}`) {
      return true;
    }

    return (
      hostname !== `app.${BASE_DOMAIN}` &&
      hostname.endsWith(`.${BASE_DOMAIN}`) &&
      !hostname.endsWith(`.app.${BASE_DOMAIN}`)
    );
  } catch {
    return false;
  }
}
