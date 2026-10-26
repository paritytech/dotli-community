// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, SITE_ID, isSiteOrigin, type SiteId } from '@dotli/config';
import type { ProtocolSchema } from './schema.js';

type StorageMethod = keyof ProtocolSchema['sections']['storage'];

export type SharedModeRequestMethod = Extract<StorageMethod, 'modeRead' | 'modeWrite' | 'modeClear'>;

export const SHARED_CORE_SESSION_KEY = 'session';

const SHARED_STORAGE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_MODE_METHODS: ReadonlySet<string> = new Set<SharedModeRequestMethod>([
  'modeRead',
  'modeWrite',
  'modeClear',
]);

/** Whether `method` is a request of the shared mode store, among the storage section's methods. */
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

/** What every shared auth key starts with. */
export const SHARED_AUTH_KEY_PREFIX = 'TRUAPI_';
/** What every shared mode key starts with. */
export const SHARED_MODE_KEY_PREFIX = 'DOTLI_MODE_';

export function buildSharedAuthStorageKey(siteId: SiteId, key: string): string {
  return `${SHARED_AUTH_KEY_PREFIX}${siteId}_${key}`;
}

/** A prefix distinct from auth's so the two stores cannot collide. */
export function buildSharedModeStorageKey(siteId: SiteId, key: string): string {
  return `${SHARED_MODE_KEY_PREFIX}${siteId}_${key}`;
}

/** Checks the raw caller key, not the namespaced `buildSharedModeStorageKey` form. */
export function isValidSharedModeKey(key: string): boolean {
  return SHARED_STORAGE_KEY_PATTERN.test(key);
}

/**
 * A host or landing page on the root domain or a subdomain, never a product, and https unless under a local root that a
 * build of kind `dev` trusts, which stands for the root domain.
 */
export function isSharedAuthOriginAllowed(origin: string, dev: boolean = import.meta.env.DEV): boolean {
  return isSiteOrigin(origin, BASE_DOMAIN, dev);
}
