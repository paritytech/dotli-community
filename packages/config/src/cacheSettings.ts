// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from '@dotli/shared';
import { activeSettings } from './activeSettings.js';

export type CacheSettings = {
  /** Skip CID cache reads and always resolve from the network. */
  skipCidCache: boolean;
  /** Neither read nor write the host block cache. */
  skipArchiveCache: boolean;
  /** Purge the protocol iframe's IndexedDB caches before init, so every cold start boots from scratch. */
  skipWorkerCache: boolean;
};

export const CACHE_KEY = 'dotli:cache-settings';

export const DEFAULT_CACHE: CacheSettings = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

/**
 * A stored cache value. A field missing from an older build's object, a value that is no object, or malformed JSON
 * falls back to the default.
 */
export function parseCacheSettings(raw: string | null): CacheSettings {
  const stored = raw === null ? null : parseJson(raw);
  if (!isRecord(stored)) {
    return { ...DEFAULT_CACHE };
  }
  return {
    skipCidCache: readSwitch(stored, 'skipCidCache'),
    skipArchiveCache: readSwitch(stored, 'skipArchiveCache'),
    skipWorkerCache: readSwitch(stored, 'skipWorkerCache'),
  };
}

/** This context's cache switches, or the defaults before boot sets the settings. */
export function getCacheSettings(): CacheSettings {
  return { ...(activeSettings()?.cache ?? DEFAULT_CACHE) };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Safe swallow: malformed JSON from an older build is a stored value to ignore, and the defaults are the fallback
    return null;
  }
}

function readSwitch(stored: Record<string, unknown>, key: keyof CacheSettings): boolean {
  const value = stored[key];
  return typeof value === 'boolean' ? value : DEFAULT_CACHE[key];
}
