// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Mode preferences shared across every `*.<BASE_DOMAIN>` subdomain, through the localStorage of the protocol frame at
// `<BASE_DOMAIN>/p/`. On a local root they live in the local server's HTTP store instead, beside the signed-in
// flag, which a cookie cannot carry there since Chromium rejects `Domain=localhost`.

import { SITE_ID, isLocalhost, BACKEND_KEY, CACHE_KEY, type SharedSettings } from '@dotli/config';
import { getProtocolClient, getProtocolOrigin } from '@dotli/protocol';
import { captureException, m, spans as S } from '@dotli/metrics';
import { getErrorName, log } from '@dotli/shared';

export type SharedChannel = {
  /** The value under `key`, or null when none is stored. Rejects when the store cannot be reached. */
  read: (key: string) => Promise<string | null>;
  /** Stores `value` under `key`. Rejects when the store cannot be reached or refuses the write. */
  write: (key: string, value: string) => Promise<void>;
  /** Removes `key`. Rejects when the store cannot be reached. */
  clear: (key: string) => Promise<void>;
};

type Params = {
  /** Where the shared settings live, the page's shared store when left out. */
  channel?: SharedChannel;
};

type CreateDevHttpChannelParams = {
  /** The origin of the local server that keeps the shared store. */
  origin: string;
  /**
   * Sends each request. The page's `fetch` by default, read at each call. Rejects when the server cannot be reached.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

/**
 * The page's channel to the store every subdomain shares, for state written on `<label>.<root>` but read on the bare
 * root, where `localStorage` cannot carry it. Never throws.
 */
export function getSharedChannel(): SharedChannel {
  return isLocalhost ? createDevHttpChannel({ origin: getProtocolOrigin() }) : createIframeChannel();
}

/** The settings other subdomains share, or null when the store cannot be read, which this reports. */
export async function readSharedSettings({
  channel = getSharedChannel(),
}: Params = {}): Promise<SharedSettings | null> {
  try {
    const [backend, cache] = await Promise.all([channel.read(BACKEND_KEY), channel.read(CACHE_KEY)]);
    m.count(S.SHARED_MODE_READ, { outcome: 'ok' });
    return { backend, cache };
  } catch (error: unknown) {
    log.error('[dot.li shared-mode] read failed, using per-origin localStorage:', error);
    captureException(error, { flow: 'boot', step: 'shared_mode_read' });
    m.count(S.SHARED_MODE_READ, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
    return null;
  }
}

/**
 * Mirrors the settings other subdomains share, and settles once every write did. Never rejects, as this origin keeps
 * its own copy, so a failed write is reported here.
 */
export async function writeSharedSettings(
  shared: SharedSettings,
  { channel = getSharedChannel() }: Params = {},
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
              (error: unknown) => {
                log.error(`[dot.li shared-mode] write of ${key} failed:`, error);
                captureException(error, { flow: 'storage', step: 'shared_mode_write' });
                m.count(S.SHARED_MODE_WRITE, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
              },
            ),
          ],
    ),
  );
}

/**
 * Builds the channel to the shared store a local server keeps at `origin`, used on a local root. Never throws.
 */
export function createDevHttpChannel({ origin, fetch = fetchFromPage }: CreateDevHttpChannelParams): SharedChannel {
  const baseUrl = `${origin}/__dotli-mode/`;

  function getUrl(key: string): string {
    return `${baseUrl}${encodeURIComponent(key)}`;
  }

  return {
    async read(key) {
      const response = await fetch(getUrl(key), { cache: 'no-store' });
      if (response.status === 204) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`mode sync read ${key} failed with HTTP ${String(response.status)}`);
      }
      const text = await response.text();
      return text === '' ? null : text;
    },
    async write(key, value) {
      const response = await fetch(getUrl(key), {
        method: 'PUT',
        body: value,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`mode sync write ${key} failed with HTTP ${String(response.status)}`);
      }
    },
    async clear(key) {
      const response = await fetch(getUrl(key), {
        method: 'DELETE',
        cache: 'no-store',
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`mode sync clear ${key} failed with HTTP ${String(response.status)}`);
      }
    },
  };
}

function createIframeChannel(): SharedChannel {
  return {
    read: key => getProtocolClient().sharedMode.read(SITE_ID, key),
    write: (key, value) => getProtocolClient().sharedMode.write({ siteId: SITE_ID, key, value }),
    clear: key => getProtocolClient().sharedMode.clear(SITE_ID, key),
  };
}

/** The page's own `fetch`, read at each call. */
function fetchFromPage(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}
