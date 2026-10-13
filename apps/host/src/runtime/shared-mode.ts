// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Mode preferences shared across every `*.<BASE_DOMAIN>` subdomain. Production uses the same-site
// `host.<BASE_DOMAIN>` iframe's unpartitioned localStorage. `localhost` is on the Public Suffix List, so
// each `*.localhost` is its own site with partitioned storage, and dev uses the preview server's HTTP store.

import { SITE_ID, isLocalhost, BACKEND_KEY, CACHE_KEY, type SharedSettings } from '@dotli/config';
import {
  getProtocolOrigin,
  readSharedModeStorage,
  writeSharedModeStorage,
  clearSharedModeStorage,
} from '@dotli/protocol';
import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';

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

/** The settings other subdomains share, or null when the store cannot be read, which this reports. */
export async function readSharedSettings(channel: SharedChannel = getSharedChannel()): Promise<SharedSettings | null> {
  try {
    const [backend, cache] = await Promise.all([channel.read(BACKEND_KEY), channel.read(CACHE_KEY)]);
    m.count(S.SHARED_MODE_READ, { outcome: 'ok' });
    return { backend, cache };
  } catch (error: unknown) {
    log.error('[dot.li shared-mode] read failed, using per-origin localStorage:', error);
    captureException(error, { flow: 'boot', step: 'shared_mode_read' });
    m.count(S.SHARED_MODE_READ, { outcome: 'error', reason: errorName(error) ?? 'unknown' });
    return null;
  }
}

/** Mirrors the settings other subdomains share. A failed write is logged, since this origin keeps its own copy. */
export function writeSharedSettings(shared: SharedSettings, channel: SharedChannel = getSharedChannel()): void {
  const entries: [string, string | null][] = [
    [BACKEND_KEY, shared.backend],
    [CACHE_KEY, shared.cache],
  ];
  for (const [key, value] of entries) {
    if (value === null) {
      continue;
    }
    void channel.write(key, value).catch((err: unknown) => {
      log.warn('[dot.li shared-mode] Write failed for', key, err);
    });
  }
}
