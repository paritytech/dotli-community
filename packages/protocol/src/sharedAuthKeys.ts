// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared auth store's keys: which site may use it, which caller keys it takes, and how they are namespaced.

import { SITE_ID, type SiteId } from '@dotli/config';

/** The shared auth key of the core session. */
export const SHARED_CORE_SESSION_KEY = 'session';
/** What every shared auth key starts with. */
export const SHARED_AUTH_KEY_PREFIX = 'TRUAPI_';

const SHARED_AUTH_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Sessions are scoped to the root domain the shell runs on, so a host accepts only its own `SITE_ID`.
 * No allowlist, so unrelated roots never share sessions and new deployment domains need no change.
 */
export function isSharedAuthSiteId(value: string): value is SiteId {
  return value === SITE_ID;
}

/** Checks the raw caller key, not the namespaced `buildSharedAuthStorageKey` form. */
export function isValidSharedAuthKey(key: string): boolean {
  return SHARED_AUTH_KEY_PATTERN.test(key);
}

/** The stored name of the caller key `key` of `siteId`. */
export function buildSharedAuthStorageKey(siteId: SiteId, key: string): string {
  return `${SHARED_AUTH_KEY_PREFIX}${siteId}_${key}`;
}
