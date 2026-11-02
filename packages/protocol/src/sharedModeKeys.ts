// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shared mode store's keys and requests: which storage methods belong to it, which caller keys it takes, and how
// they are namespaced.

import type { SiteId } from '@dotli/config';
import type { ProtocolSchema } from './schema.js';

type StorageMethod = keyof ProtocolSchema['sections']['storage'];

/** The storage section's methods that the shared mode store serves. */
export type SharedModeRequestMethod = Extract<StorageMethod, 'modeRead' | 'modeWrite' | 'modeClear'>;

/** What every shared mode key starts with. No other store's prefix may equal it, so the stores cannot collide. */
export const SHARED_MODE_KEY_PREFIX = 'DOTLI_MODE_';

const SHARED_MODE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_MODE_METHODS: ReadonlySet<string> = new Set<SharedModeRequestMethod>([
  'modeRead',
  'modeWrite',
  'modeClear',
]);

/** Whether `method` is a request of the shared mode store, among the storage section's methods. */
export function isSharedModeRequestMethod(method: string): method is SharedModeRequestMethod {
  return SHARED_MODE_METHODS.has(method);
}

/** Checks the raw caller key, not the namespaced `buildSharedModeStorageKey` form. */
export function isValidSharedModeKey(key: string): boolean {
  return SHARED_MODE_KEY_PATTERN.test(key);
}

/** The stored name of the caller key `key` of `siteId`. */
export function buildSharedModeStorageKey(siteId: SiteId, key: string): string {
  return `${SHARED_MODE_KEY_PREFIX}${siteId}_${key}`;
}
