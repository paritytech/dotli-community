// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Mode preferences shared across every `*.<BASE_DOMAIN>` subdomain, through the localStorage of the protocol frame at
// `<BASE_DOMAIN>/p/`. On a local root they live in the local server's HTTP store instead, beside the signed-in
// flag, which a cookie cannot carry there since Chromium rejects `Domain=localhost`.

import { SITE_ID, isLocalhost, BACKEND_KEY, CACHE_KEY, type SharedSettings } from '@dotli/config';
import { getProtocolOrigin, protocolClient } from '@dotli/protocol';
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
    read: key => protocolClient().readSharedModeStorage(SITE_ID, key),
    write: (key, value) => protocolClient().writeSharedModeStorage(SITE_ID, key, value),
    clear: key => protocolClient().clearSharedModeStorage(SITE_ID, key),
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

/**
 * Mirrors the settings other subdomains share, and settles once every write did. Never rejects, as this origin keeps
 * its own copy, so a failed write is reported here.
 */
export async function writeSharedSettings(
  shared: SharedSettings,
  channel: SharedChannel = getSharedChannel(),
): Promise<void> {
  const entries: [string, string | null][] = [
    [BACKEND_KEY, shared.backend],
    [CACHE_KEY, shared.cache],
  ];
  await Promise.all(
    entries.flatMap(([key, value]) =>
      value === null
        ? []
        : [
            channel.write(key, value).then(
              () => {
                m.count(S.SHARED_MODE_WRITE, { outcome: 'ok' });
              },
              (err: unknown) => {
                log.error(`[dot.li shared-mode] write of ${key} failed:`, err);
                captureException(err, { flow: 'storage', step: 'shared_mode_write' });
                m.count(S.SHARED_MODE_WRITE, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
              },
            ),
          ],
    ),
  );
}
