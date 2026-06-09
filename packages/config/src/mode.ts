// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Backend selection and cache settings.
//
//   smoldot-direct: smoldot runs in the protocol iframe. Chain access
//                   uses smoldot, content fetch uses smoldot's
//                   `bitswap_v1_get` against the Bulletin Chain.
//   smoldot-shared-worker: same as above but smoldot lives in a SharedWorker,
//                   so multiple tabs share one light client.
//   rpc-gateway: chain access via WSS JSON-RPC to a trusted node, content
//                fetch via HTTPS IPFS gateway. No smoldot.

export type Backend =
  | "smoldot-direct"
  | "smoldot-shared-worker"
  | "rpc-gateway";

export interface CacheSettings {
  /** When true, skip CID cache reads. Always resolve from chain/RPC. */
  skipCidCache: boolean;
  /** When true, skip SW archive cache reads. Always fetch content. */
  skipArchiveCache: boolean;
  /**
   * When true, the protocol iframe purges its persistent worker caches
   * (IndexedDB) before smoldot/broker init, so every cold start boots
   * from scratch. Trades cold-start time for a deterministic baseline,
   * useful for debugging "is the cache hiding the issue?" scenarios.
   */
  skipWorkerCache: boolean;
}

export const BACKEND_KEY = "dotli:chain-backend";
export const CACHE_KEY = "dotli:cache-settings";

export function isSharedWorkerAvailable(): boolean {
  return typeof SharedWorker !== "undefined";
}

// Pre-collapse keys. `rpc` chain backend maps to `rpc-gateway`. Legacy
// `dotli:mode` and `dotli:content-backend` carried the content axis that
// no longer exists. Read once, migrate, delete.
const LEGACY_MODE_KEY = "dotli:mode";
const LEGACY_CONTENT_BACKEND_KEY = "dotli:content-backend";

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  "smoldot-direct",
  "smoldot-shared-worker",
  "rpc-gateway",
]);

/**
 * Synchronous storage adapter for mode preferences. Readers across the
 * codebase (sandbox URL builder, diagnostics, etc.) are not async-
 * friendly, so any cross-origin store must hydrate an in-memory cache
 * during boot and serve sync reads from there.
 */
export interface ModeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const localStorageAdapter: ModeStorage = {
  getItem: (key) => {
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
  removeItem: (key) => {
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
 * Replace the storage backend used by every accessor below. Call once
 * during host shell boot, before any reader runs. Swapping at runtime is
 * allowed but stale values already returned to callers are NOT
 * invalidated. Readers see the new adapter only on their next call.
 */
export function configureModeStorage(adapter: ModeStorage): void {
  storage = adapter;
}

/**
 * Run the one-shot legacy-key migration against a given `ModeStorage`,
 * writing the migrated backend back to `target[BACKEND_KEY]` so a
 * subsequent reader picks it up at the canonical key. The shared-mode
 * bootstrap calls this against per-origin `localStorage` *before* swapping
 * the adapter, so legacy `dotli:mode` / `dotli:content-backend` values
 * survive the swap to the cache-only adapter (which only sees the two
 * SHARED_KEYS).
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
    if (stored === "smoldot-shared-worker" && !isSharedWorkerAvailable()) {
      storage.removeItem(BACKEND_KEY);
      return "smoldot-direct";
    }
    return stored as Backend;
  }
  const migrated = migrateLegacyOn(storage);
  if (migrated !== null) {
    if (migrated === "smoldot-shared-worker" && !isSharedWorkerAvailable()) {
      storage.removeItem(BACKEND_KEY);
      return "smoldot-direct";
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
  return isSharedWorkerAvailable() ? "smoldot-shared-worker" : "smoldot-direct";
}

/**
 * Map any legacy stored value to a canonical `Backend`, clearing the
 * legacy keys on success. Pre-collapse `dotli:mode` and
 * `dotli:content-backend` carried the content axis that no longer
 * exists. A stored `chain-backend = "rpc"` becomes `"rpc-gateway"`. The
 * caller decides whether to write the result back at `BACKEND_KEY`.
 */
function readAndClearLegacy(target: ModeStorage): Backend | null {
  const chain = target.getItem(BACKEND_KEY);
  const content = target.getItem(LEGACY_CONTENT_BACKEND_KEY);
  const legacyMode = target.getItem(LEGACY_MODE_KEY);
  let chosen: Backend | null = null;
  if (chain === "rpc" || content === "ipfs-gateway") {
    chosen = "rpc-gateway";
  } else if (legacyMode === "p2p-shared-worker" || legacyMode === "p2p") {
    chosen = "smoldot-shared-worker";
  } else if (legacyMode === "p2p-direct") {
    chosen = "smoldot-direct";
  } else if (legacyMode === "gateway" || legacyMode === "centralized") {
    chosen = "rpc-gateway";
  }
  if (chosen !== null) {
    target.removeItem(LEGACY_MODE_KEY);
    target.removeItem(LEGACY_CONTENT_BACKEND_KEY);
  }
  return chosen;
}

/**
 * Canonical trust-posture helper for user-facing shields and indicators.
 *
 * A session is "verified" iff the backend uses smoldot end-to-end. The
 * `rpc-gateway` backend delegates both chain access and content fetch to
 * trusted operators, so it's "trusted" rather than "verified".
 */
export function isVerifiedSession(chainBackend: Backend): boolean {
  return chainBackend !== "rpc-gateway";
}

// Fresh-install default. Persisted preferences override these.
const DEFAULT_CACHE: CacheSettings = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

/**
 * Get the effective cache settings.
 *
 * Cache preferences are the user's to choose regardless of backend.
 * (Earlier versions coupled gateway mode to "no cache", which meant the
 * user couldn't say "I want gateway *and* keep the CID cache". Cache
 * flags are now honored as-set.)
 *
 * When a stored preference omits a field (older build wrote a partial
 * object), the missing field falls back to `DEFAULT_CACHE` so the new
 * all-off default applies instead of the structural zero-value `false`.
 */
export function getCacheSettings(): CacheSettings {
  const stored = storage.getItem(CACHE_KEY);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as Partial<CacheSettings>;
      return {
        skipCidCache:
          typeof parsed.skipCidCache === "boolean"
            ? parsed.skipCidCache
            : DEFAULT_CACHE.skipCidCache,
        skipArchiveCache:
          typeof parsed.skipArchiveCache === "boolean"
            ? parsed.skipArchiveCache
            : DEFAULT_CACHE.skipArchiveCache,
        skipWorkerCache:
          typeof parsed.skipWorkerCache === "boolean"
            ? parsed.skipWorkerCache
            : DEFAULT_CACHE.skipWorkerCache,
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
