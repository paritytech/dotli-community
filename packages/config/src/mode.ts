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

/** Whether `scope` (the page's global by default) can start a SharedWorker. */
export function isSharedWorkerAvailable(scope: { SharedWorker?: unknown } = globalThis): boolean {
  return typeof scope.SharedWorker !== 'undefined';
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

/**
 * Call once at host boot, before any reader. A later swap does not invalidate values already returned. Returns a
 * function that puts the previous store back.
 */
export function configureModeStorage(adapter: ModeStorage): () => void {
  const previous = storage;
  storage = adapter;
  return () => {
    storage = previous;
  };
}

/** The store every setting of this package is read from and written to. */
export function modeStorage(): ModeStorage {
  return storage;
}

/** Moves an old build's keys into `BACKEND_KEY` on `target`. */
export function migrateLegacyOn(target: ModeStorage): void {
  const migrated = readAndClearLegacy(target);
  if (migrated !== null) {
    target.setItem(BACKEND_KEY, migrated);
  }
}

/** From the stored choice, an old build's keys or the default. Writes nothing, `persistDefaults` stores it. */
export function getBackend(): Backend {
  return backendRunnable(isSharedWorkerAvailable());
}

/** `getBackend` for a browser that has SharedWorker or not. */
export function backendRunnable(sharedWorkerAvailable: boolean): Backend {
  const chosen = storedBackend(storage) ?? readLegacy(storage) ?? defaultBackend();
  return chosen === 'smoldot-shared-worker' && !sharedWorkerAvailable ? 'smoldot-direct' : chosen;
}

function storedBackend(target: ModeStorage): Backend | null {
  const stored = target.getItem(BACKEND_KEY);
  return stored !== null && VALID_BACKENDS.has(stored) ? (stored as Backend) : null;
}

export function setBackend(chainBackend: Backend): void {
  storage.setItem(BACKEND_KEY, chainBackend);
}

export function defaultBackend(): Backend {
  return 'smoldot-direct';
}

/** Clears the legacy keys on success. The caller decides whether to write the result back. */
function readAndClearLegacy(target: ModeStorage): Backend | null {
  const chosen = readLegacy(target);
  if (chosen !== null) {
    target.removeItem(LEGACY_MODE_KEY);
    target.removeItem(LEGACY_CONTENT_BACKEND_KEY);
  }
  return chosen;
}

function readLegacy(target: ModeStorage): Backend | null {
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
