// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Shared mode-preferences bootstrap
//
// Mode preferences (chain backend and cache settings) live behind a
// single source of truth that every `*.<BASE_DOMAIN>` subdomain can
// hit. The transport differs by environment:
//
//   * Production (`*.dot.li`, `*.paseo.li`, …): the
//     `host.<BASE_DOMAIN>` iframe's localStorage. Browsers treat the
//     embedder and the iframe as same-site (shared `eTLD+1`), so the
//     iframe's storage isn't partitioned and all subdomains see the
//     same backing store.
//   * Localhost dev: `localhost` is on the Public Suffix List, so
//     every `*.localhost` subdomain is its own site and browsers
//     partition the iframe's localStorage per embedder. Writes from
//     `browse.localhost` aren't visible to the iframe embedded under
//     `host-playground.localhost`. The preview server exposes a
//     `/__dotli-mode/<key>` HTTP store that all subdomains hit. That
//     bypasses partitioning entirely.
//
// The bootstrap detects which channel applies, hydrates an in-memory
// cache, and swaps the mode-storage adapter so every sync caller
// (`getBackend`, `getCacheSettings`, …) resolves against the cache.
// Writes go through the same channel that produced the read.

import { SITE_ID, isLocalhost } from "@dotli/config/config";
import {
  BACKEND_KEY,
  CACHE_KEY,
  configureModeStorage,
  getBackend,
  localStorageAdapter,
  migrateLegacyOn,
  type ModeStorage,
} from "@dotli/config/mode";
import {
  getProtocolOrigin,
  readSharedModeStorage,
  resetProtocolFrame,
  writeSharedModeStorage,
  clearSharedModeStorage,
} from "@dotli/protocol/client";
import { log } from "@dotli/shared/log";

const SHARED_KEYS: readonly string[] = [BACKEND_KEY, CACHE_KEY];

let bootstrapped = false;

interface SharedChannel {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
  clear: (key: string) => Promise<void>;
}

function devHttpChannel(): SharedChannel {
  const baseUrl = `${getProtocolOrigin()}/__dotli-mode/`;
  const url = (key: string): string => `${baseUrl}${encodeURIComponent(key)}`;
  return {
    read: async (key) => {
      const res = await fetch(url(key), { cache: "no-store" });
      // 204 (= absent) is symmetric with the raw-text PUT side.
      if (res.status === 204) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`mode sync read ${key} → HTTP ${String(res.status)}`);
      }
      const text = await res.text();
      return text === "" ? null : text;
    },
    write: async (key, value) => {
      const res = await fetch(url(key), {
        method: "PUT",
        body: value,
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`mode sync write ${key} → HTTP ${String(res.status)}`);
      }
    },
    clear: async (key) => {
      const res = await fetch(url(key), {
        method: "DELETE",
        cache: "no-store",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`mode sync clear ${key} → HTTP ${String(res.status)}`);
      }
    },
  };
}

function iframeChannel(): SharedChannel {
  return {
    read: (key) => readSharedModeStorage(SITE_ID, key),
    write: (key, value) => writeSharedModeStorage(SITE_ID, key, value),
    clear: (key) => clearSharedModeStorage(SITE_ID, key),
  };
}

/**
 * Hydrate mode preferences from the shared store (iframe in production,
 * preview-server HTTP endpoint in dev) and install a storage adapter
 * that mirrors writes back. Subsequent `getBackend`/`getCacheSettings`
 * calls resolve synchronously against the hydrated cache.
 *
 * Idempotent: a second invocation resolves immediately without
 * re-reading the iframe.
 */
export async function bootstrapSharedMode(): Promise<void> {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;

  // Run legacy migration against `localStorage` *before* we swap the
  // adapter. After the swap, the cache-only adapter only sees the two
  // SHARED_KEYS, so `dotli:mode` and `dotli:content-backend` would be
  // invisible to `migrateLegacy`, and a user whose only prior signal was
  // a legacy key would silently get the default backend.
  migrateLegacyOn(localStorageAdapter);

  // Snapshot the backend the host iframe will be loaded with. The first
  // `readSharedModeStorage` call below creates the iframe with this
  // mode (the protocol client falls back to `getBackend()` when no
  // explicit sub-mode is set). If the shared value resolves to
  // something else we tear the iframe down so the next chain op
  // rebuilds it correctly.
  const localBackendBeforeBootstrap = getBackend();

  // Hydrate the cache from per-origin localStorage synchronously so any
  // reader between here and the async overlay still resolves to a real
  // value instead of a missing slot.
  const channel = isLocalhost ? devHttpChannel() : iframeChannel();
  const cache = new Map<string, string | null>(
    SHARED_KEYS.map((key) => [key, localStorageAdapter.getItem(key)]),
  );

  // On unreachable shared store (preview down or iframe blocked) we leave
  // the cache as already hydrated from localStorage and never install
  // the cache-only adapter. The host shell keeps booting on the
  // per-origin path.
  let sharedReads: readonly (string | null)[];
  try {
    sharedReads = await Promise.all(
      SHARED_KEYS.map((key) => channel.read(key)),
    );
  } catch (error: unknown) {
    log.warn(
      "[dot.li shared-mode] Initial read failed; using per-origin localStorage:",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const mirrorUp = (key: string, value: string, label: string): void => {
    void channel.write(key, value).catch((err: unknown) => {
      log.warn(
        `[dot.li shared-mode] ${label} failed for`,
        key,
        err instanceof Error ? err.message : err,
      );
    });
  };

  SHARED_KEYS.forEach((key, i) => {
    const shared = sharedReads[i];
    const seed = cache.get(key) ?? null;

    // Localhost dev prefers the per-origin seed over the shared store.
    // The browser already partitions storage per `*.localhost` (PSL), so
    // the shared HTTP store is a wire-level simulation, not a physical
    // fact. Treating localStorage as authoritative is what isolates
    // parallel Playwright workers from each other's bootstrap writes.
    // Production keeps shared over local below (real eTLD+1 sharing).
    if (isLocalhost && seed !== null) {
      if (shared !== seed) {
        mirrorUp(key, seed, "Localhost mirror-up");
      }
      return;
    }
    if (shared !== null) {
      cache.set(key, shared);
      return;
    }
    if (seed !== null) {
      mirrorUp(key, seed, "Migration write");
    }
  });

  const adapter: ModeStorage = {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => {
      cache.set(key, value);
      // Mirror to per-origin localStorage as a fallback so a later boot
      // that can't reach the shared store still sees the user's choice.
      try {
        localStorage.setItem(key, value);
        // eslint-disable-next-line no-restricted-syntax -- best-effort mirror; the shared write below is the authoritative path.
      } catch {
        /* localStorage unavailable */
      }
      void channel.write(key, value).catch((err: unknown) => {
        log.warn(
          "[dot.li shared-mode] Write failed for",
          key,
          err instanceof Error ? err.message : err,
        );
      });
    },
    removeItem: (key) => {
      cache.set(key, null);
      try {
        localStorage.removeItem(key);
        // eslint-disable-next-line no-restricted-syntax -- mirror-only cleanup; the shared clear below is authoritative.
      } catch {
        /* localStorage unavailable */
      }
      void channel.clear(key).catch((err: unknown) => {
        log.warn(
          "[dot.li shared-mode] Clear failed for",
          key,
          err instanceof Error ? err.message : err,
        );
      });
    },
  };

  configureModeStorage(adapter);

  // The host iframe came up with whatever mode `getBackend()` returned
  // before we swapped the adapter. If the shared store had a different
  // backend, force a fresh iframe so chain operations don't run against
  // a worker mode the user didn't pick. (Only relevant on the iframe
  // path. The dev HTTP channel doesn't load an iframe during reads.)
  if (!isLocalhost && getBackend() !== localBackendBeforeBootstrap) {
    resetProtocolFrame();
  }
}
