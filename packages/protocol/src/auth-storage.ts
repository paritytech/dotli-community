// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, SITE_ID, type SiteId } from '@dotli/config';
import type { MethodName } from '@dotli/transport';
import type { ProtocolSchema } from './schema.js';

type StorageMethod = MethodName<ProtocolSchema, 'storage'>;

export type SharedModeRequestMethod = Extract<StorageMethod, 'modeRead' | 'modeWrite' | 'modeClear'>;

export const SHARED_CORE_SESSION_KEY = 'session';

const SHARED_STORAGE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_MODE_METHODS: ReadonlySet<string> = new Set<SharedModeRequestMethod>([
  'modeRead',
  'modeWrite',
  'modeClear',
]);

/** Whether `method` is a request of the shared mode store, among the storage trait's methods. */
export function isSharedModeRequestMethod(method: string): method is SharedModeRequestMethod {
  return SHARED_MODE_METHODS.has(method);
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
