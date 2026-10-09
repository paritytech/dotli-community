// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Mode preferences shared across every `*.<BASE_DOMAIN>` subdomain. Production uses the same-site
// `host.<BASE_DOMAIN>` iframe's unpartitioned localStorage. `localhost` is on the Public Suffix List, so
// each `*.localhost` is its own site with partitioned storage, and dev uses the preview server's HTTP store.

import {
  SITE_ID,
  isLocalhost,
  BACKEND_KEY,
  CACHE_KEY,
  configureModeStorage,
  getBackend,
  localStorageAdapter,
  migrateLegacyOn,
  type ModeStorage,
} from '@dotli/config';

import {
  getProtocolOrigin,
  readSharedModeStorage,
  resetProtocolFrame,
  writeSharedModeStorage,
  clearSharedModeStorage,
} from '@dotli/protocol';
import { log } from '@dotli/shared';

const SHARED_KEYS: readonly string[] = [BACKEND_KEY, CACHE_KEY];

let bootstrapped = false;

export interface SharedChannel {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
  clear: (key: string) => Promise<void>;
}

function devHttpChannel(): SharedChannel {
  const baseUrl = `${getProtocolOrigin()}/__dotli-mode/`;
  const url = (key: string): string => `${baseUrl}${encodeURIComponent(key)}`;
  return {
    read: async key => {
      const res = await fetch(url(key), { cache: 'no-store' });
      if (res.status === 204) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`mode sync read ${key} failed with HTTP ${String(res.status)}`);
      }
      const text = await res.text();
      return text === '' ? null : text;
    },
    write: async (key, value) => {
      const res = await fetch(url(key), {
        method: 'PUT',
        body: value,
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`mode sync write ${key} failed with HTTP ${String(res.status)}`);
      }
    },
    clear: async key => {
      const res = await fetch(url(key), {
        method: 'DELETE',
        cache: 'no-store',
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`mode sync clear ${key} failed with HTTP ${String(res.status)}`);
      }
    },
  };
}

function iframeChannel(): SharedChannel {
  return {
    read: key => readSharedModeStorage(SITE_ID, key),
    write: (key, value) => writeSharedModeStorage(SITE_ID, key, value),
    clear: key => clearSharedModeStorage(SITE_ID, key),
  };
}

/** For state written on `<label>.<root>` but read on the bare root, where `localStorage` cannot carry it. */
export function getSharedChannel(): SharedChannel {
  return isLocalhost ? devHttpChannel() : iframeChannel();
}

/** Hydrates a cache so sync callers like `getBackend` resolve against it, and mirrors writes back. Idempotent. */
export async function bootstrapSharedMode(): Promise<void> {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;

  // Before the swap, since the cache-only adapter cannot see the legacy keys.
  migrateLegacyOn(localStorageAdapter);

  // The first shared read below boots the host iframe with this backend.
  const localBackendBeforeBootstrap = getBackend();

  const channel = getSharedChannel();
  const cache = new Map<string, string | null>(SHARED_KEYS.map(key => [key, localStorageAdapter.getItem(key)]));

  // An unreachable shared store leaves the per-origin path in place.
  let sharedReads: readonly (string | null)[];
  try {
    sharedReads = await Promise.all(SHARED_KEYS.map(key => channel.read(key)));
  } catch (error: unknown) {
    log.warn('[dot.li shared-mode] Initial read failed; using per-origin localStorage:', error);
    return;
  }

  const mirrorUp = (key: string, value: string, label: string): void => {
    void channel.write(key, value).catch((err: unknown) => {
      log.warn(`[dot.li shared-mode] ${label} failed for`, key, err);
    });
  };

  SHARED_KEYS.forEach((key, i) => {
    const shared = sharedReads[i] ?? null;
    const seed = cache.get(key) ?? null;

    // Localhost prefers the per-origin seed, which isolates parallel Playwright workers from each
    // other's bootstrap writes.
    if (isLocalhost && seed !== null) {
      if (shared !== seed) {
        mirrorUp(key, seed, 'Localhost mirror-up');
      }
      return;
    }
    if (shared !== null) {
      cache.set(key, shared);
      return;
    }
    if (seed !== null) {
      mirrorUp(key, seed, 'Migration write');
    }
  });

  const adapter: ModeStorage = {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => {
      cache.set(key, value);
      // So a later boot that cannot reach the shared store still sees the choice.
      try {
        localStorage.setItem(key, value);
        // eslint-disable-next-line no-restricted-syntax -- best-effort mirror; the shared write below is the authoritative path.
      } catch {
        // localStorage unavailable.
      }
      void channel.write(key, value).catch((err: unknown) => {
        log.warn('[dot.li shared-mode] Write failed for', key, err);
      });
    },
    removeItem: key => {
      cache.set(key, null);
      try {
        localStorage.removeItem(key);
        // eslint-disable-next-line no-restricted-syntax -- mirror-only cleanup; the shared clear below is authoritative.
      } catch {
        // localStorage unavailable.
      }
      void channel.clear(key).catch((err: unknown) => {
        log.warn('[dot.li shared-mode] Clear failed for', key, err);
      });
    },
  };

  configureModeStorage(adapter);

  // The iframe booted with the pre-swap backend, so a different shared one needs a fresh frame.
  // The dev HTTP channel loads no iframe during reads.
  if (!isLocalhost && getBackend() !== localBackendBeforeBootstrap) {
    resetProtocolFrame();
  }
}
