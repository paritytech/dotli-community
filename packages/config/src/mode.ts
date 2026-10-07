// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// smoldot-direct runs smoldot in the protocol iframe, smoldot-shared-worker in a SharedWorker that tabs share.
// rpc-gateway uses a trusted JSON-RPC node and an IPFS gateway, with no smoldot.

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

export function isSharedWorkerAvailable(): boolean {
  return typeof SharedWorker !== 'undefined';
}

// Read once, migrated and deleted.
const LEGACY_MODE_KEY = 'dotli:mode';
const LEGACY_CONTENT_BACKEND_KEY = 'dotli:content-backend';

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  'smoldot-direct',
  'smoldot-shared-worker',
  'rpc-gateway',
]);

/** Sync because readers are not async-friendly. A cross-origin store must hydrate a memory cache at boot. */
export interface ModeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const localStorageAdapter: ModeStorage = {
  getItem: key => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
      // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies); writers drop silently and readers fall back to defaults.
    } catch {
      /* localStorage unavailable */
    }
  },
  removeItem: key => {
    try {
      localStorage.removeItem(key);
      // eslint-disable-next-line no-restricted-syntax -- mirror cleanup; readers tolerate the stale value on the next boot.
    } catch {
      /* localStorage unavailable */
    }
  },
};

let storage: ModeStorage = localStorageAdapter;

/** Call once at host boot, before any reader. A later swap does not invalidate values already returned. */
export function configureModeStorage(adapter: ModeStorage): void {
  storage = adapter;
}

/**
 * Migrates legacy keys into `BACKEND_KEY` on `target`. The shared-mode bootstrap runs it on per-origin localStorage
 * before swapping to the cache-only adapter, which cannot see legacy keys.
 */
export function migrateLegacyOn(target: ModeStorage): Backend | null {
  const migrated = readAndClearLegacy(target);
  if (migrated !== null) {
    target.setItem(BACKEND_KEY, migrated);
  }
  return migrated;
}

export function getBackend(): Backend {
  const stored = storage.getItem(BACKEND_KEY);
  if (stored !== null && VALID_BACKENDS.has(stored)) {
    if (stored === 'smoldot-shared-worker' && !isSharedWorkerAvailable()) {
      storage.removeItem(BACKEND_KEY);
      return 'smoldot-direct';
    }
    return stored as Backend;
  }
  const migrated = migrateLegacyOn(storage);
  if (migrated !== null) {
    if (migrated === 'smoldot-shared-worker' && !isSharedWorkerAvailable()) {
      storage.removeItem(BACKEND_KEY);
      return 'smoldot-direct';
    }
    return migrated;
  }
  const computed = defaultBackend();
  storage.setItem(BACKEND_KEY, computed);
  return computed;
}

export function setBackend(chainBackend: Backend): void {
  storage.setItem(BACKEND_KEY, chainBackend);
}

export function defaultBackend(): Backend {
  return 'smoldot-direct';
}

/** Clears the legacy keys on success. The caller decides whether to write the result back. */
function readAndClearLegacy(target: ModeStorage): Backend | null {
  const chain = target.getItem(BACKEND_KEY);
  const content = target.getItem(LEGACY_CONTENT_BACKEND_KEY);
  const legacyMode = target.getItem(LEGACY_MODE_KEY);
  let chosen: Backend | null = null;
  if (chain === 'rpc' || content === 'ipfs-gateway') {
    chosen = 'rpc-gateway';
  } else if (legacyMode === 'p2p-shared-worker' || legacyMode === 'p2p') {
    chosen = 'smoldot-shared-worker';
  } else if (legacyMode === 'p2p-direct') {
    chosen = 'smoldot-direct';
  } else if (legacyMode === 'gateway' || legacyMode === 'centralized') {
    chosen = 'rpc-gateway';
  }
  if (chosen !== null) {
    target.removeItem(LEGACY_MODE_KEY);
    target.removeItem(LEGACY_CONTENT_BACKEND_KEY);
  }
  return chosen;
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

/** A field missing from an older build's stored object falls back to `DEFAULT_CACHE`. */
export function getCacheSettings(): CacheSettings {
  const stored = storage.getItem(CACHE_KEY);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as Partial<CacheSettings>;
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

export function setCacheSettings(settings: CacheSettings): void {
  storage.setItem(CACHE_KEY, JSON.stringify(settings));
}
