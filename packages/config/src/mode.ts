// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// smoldot-direct runs smoldot in the protocol iframe, smoldot-shared-worker in a SharedWorker that tabs share.
// rpc-gateway uses a trusted JSON-RPC node and an IPFS gateway, with no smoldot.

import { activeSettings } from './active-settings.js';

export type Backend = 'smoldot-direct' | 'smoldot-shared-worker' | 'rpc-gateway';

/** Settings panel labels. Here rather than in the topbar because error copy names these controls, and copies drift. */
export const BACKEND_LABELS: Record<Backend, string> = {
  'smoldot-direct': 'Light client per tab',
  'smoldot-shared-worker': 'Light client shared',
  'rpc-gateway': 'Trusted providers',
};

export interface CacheSettings {
  /** Skip CID cache reads and always resolve from the network. */
  skipCidCache: boolean;
  /** Neither read nor write the host block cache. */
  skipArchiveCache: boolean;
  /** Purge the protocol iframe's IndexedDB caches before init, so every cold start boots from scratch. */
  skipWorkerCache: boolean;
}

export const BACKEND_KEY = 'dotli:chain-backend';
export const CACHE_KEY = 'dotli:cache-settings';

/** Whether `scope` (the page's global by default) can start a SharedWorker. */
export function isSharedWorkerAvailable(scope: { SharedWorker?: unknown } = globalThis): boolean {
  return typeof scope.SharedWorker !== 'undefined';
}

// Read once, migrated and deleted.
const LEGACY_MODE_KEY = 'dotli:mode';
const LEGACY_CONTENT_BACKEND_KEY = 'dotli:content-backend';

/** An old build's keys, read once and removed when the settings are next stored. */
export const LEGACY_KEYS: readonly string[] = [LEGACY_MODE_KEY, LEGACY_CONTENT_BACKEND_KEY];

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  'smoldot-direct',
  'smoldot-shared-worker',
  'rpc-gateway',
]);

/** A stored backend, or null when the value names none this build knows. */
export function parseBackend(raw: string | null): Backend | null {
  return raw !== null && VALID_BACKENDS.has(raw) ? (raw as Backend) : null;
}

/** This context's backend, or the default before boot sets the settings. */
export function getBackend(): Backend {
  return activeSettings()?.backend ?? defaultBackend();
}

export function defaultBackend(): Backend {
  return 'smoldot-direct';
}

/** The backend an old build's keys name, or null. */
export function legacyBackend(target: Pick<Storage, 'getItem'>): Backend | null {
  const chain = target.getItem(BACKEND_KEY);
  const content = target.getItem(LEGACY_CONTENT_BACKEND_KEY);
  const legacyMode = target.getItem(LEGACY_MODE_KEY);
  if (chain === 'rpc' || content === 'ipfs-gateway') {
    return 'rpc-gateway';
  }
  if (legacyMode === 'p2p-shared-worker' || legacyMode === 'p2p') {
    return 'smoldot-shared-worker';
  }
  if (legacyMode === 'p2p-direct') {
    return 'smoldot-direct';
  }
  if (legacyMode === 'gateway' || legacyMode === 'centralized') {
    return 'rpc-gateway';
  }
  return null;
}

/** Verified means smoldot end to end. rpc-gateway trusts operators for chain access and content. */
export function isVerifiedSession(chainBackend: Backend): boolean {
  return chainBackend !== 'rpc-gateway';
}

const DEFAULT_CACHE: CacheSettings = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

/** A stored cache value. A field missing from an older build's object, or malformed JSON, falls back to the default. */
export function parseCacheSettings(raw: string | null): CacheSettings {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<CacheSettings>;
      return {
        skipCidCache: typeof parsed.skipCidCache === 'boolean' ? parsed.skipCidCache : DEFAULT_CACHE.skipCidCache,
        skipArchiveCache:
          typeof parsed.skipArchiveCache === 'boolean' ? parsed.skipArchiveCache : DEFAULT_CACHE.skipArchiveCache,
        skipWorkerCache:
          typeof parsed.skipWorkerCache === 'boolean' ? parsed.skipWorkerCache : DEFAULT_CACHE.skipWorkerCache,
      };
      // eslint-disable-next-line no-restricted-syntax -- malformed JSON from an older build; defaults are the safe fallback.
    } catch {
      /* malformed JSON. Fall back to defaults. */
    }
  }
  return { ...DEFAULT_CACHE };
}

/** This context's cache switches, or the defaults before boot sets the settings. */
export function getCacheSettings(): CacheSettings {
  return { ...(activeSettings()?.cache ?? DEFAULT_CACHE) };
}
