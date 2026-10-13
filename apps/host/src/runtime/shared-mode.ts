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
  localStorageAdapter,
  type ModeStorage,
} from '@dotli/config';
import {
  getProtocolOrigin,
  readSharedModeStorage,
  writeSharedModeStorage,
  clearSharedModeStorage,
} from '@dotli/protocol';
import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, errorName, log } from '@dotli/shared';

const SHARED_KEYS: readonly string[] = [BACKEND_KEY, CACHE_KEY];

// The network travels in each page's URL instead, so it stays on this origin.
function isShared(key: string): boolean {
  return SHARED_KEYS.includes(key);
}

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

/**
 * Hydrates a cache so sync callers like `getBackend` resolve against it, and mirrors writes back. Idempotent, and a
 * call that overlaps another settles with it. Runs after `persistDefaults`, so its seeds, read from per-origin storage,
 * already hold the migrated backend and the defaults. A shared value then keeps precedence, and a fresh origin mirrors
 * its default up.
 */
export type BootstrapSharedMode = (channel?: SharedChannel) => Promise<void>;

/** A bootstrap with its own queue and done state. The page keeps one, `bootstrapSharedMode`. */
export function createSharedModeBootstrap(local: ModeStorage = localStorageAdapter): BootstrapSharedMode {
  // One bootstrap at a time, so a caller that overlaps one waits for the cache it configures.
  const bootstraps = createAsyncTaskPool({ poolSize: 1 });
  // Set only once the cache is configured, so a bootstrap whose read failed is run again by the next caller.
  let bootstrapped = false;
  return (channel = getSharedChannel()) =>
    bootstraps.call(async () => {
      if (!bootstrapped) {
        bootstrapped = await configureSharedMode(channel, local);
      }
    });
}

export const bootstrapSharedMode: BootstrapSharedMode = createSharedModeBootstrap();

/** Configures the mode storage over the shared store. False when the store cannot be read, so the next call retries. */
async function configureSharedMode(channel: SharedChannel, local: ModeStorage): Promise<boolean> {
  const cache = new Map<string, string | null>(SHARED_KEYS.map(key => [key, local.getItem(key)]));

  // An unreachable shared store leaves the per-origin path in place.
  let sharedReads: readonly (string | null)[];
  try {
    sharedReads = await Promise.all(SHARED_KEYS.map(key => channel.read(key)));
  } catch (error: unknown) {
    log.error('[dot.li shared-mode] initial read failed, using per-origin localStorage:', error);
    captureException(error, { flow: 'boot', step: 'shared_mode_read' });
    m.count(S.SHARED_MODE_READ, { outcome: 'error', reason: errorName(error) ?? 'unknown' });
    return false;
  }
  m.count(S.SHARED_MODE_READ, { outcome: 'ok' });

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
    getItem: key => (isShared(key) ? (cache.get(key) ?? null) : local.getItem(key)),
    setItem: (key, value) => {
      if (!isShared(key)) {
        local.setItem(key, value);
        return;
      }
      cache.set(key, value);
      // So a later boot that cannot reach the shared store still sees the choice.
      local.setItem(key, value);
      void channel.write(key, value).catch((err: unknown) => {
        log.warn('[dot.li shared-mode] Write failed for', key, err);
      });
    },
    removeItem: key => {
      if (!isShared(key)) {
        local.removeItem(key);
        return;
      }
      cache.set(key, null);
      local.removeItem(key);
      void channel.clear(key).catch((err: unknown) => {
        log.warn('[dot.li shared-mode] Clear failed for', key, err);
      });
    },
  };

  configureModeStorage(adapter);
  return true;
}
