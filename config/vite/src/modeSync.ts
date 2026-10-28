// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Production shares mode preferences through the localStorage of the protocol frame at `<BASE_DOMAIN>/p/`, and
// says whether a sign-in exists with a cookie on `<BASE_DOMAIN>`, which Chromium rejects for `Domain=localhost`. Local
// servers keep both in memory instead, on the root origin, reached at `/__dotli-mode/`.

import { Readable } from 'node:stream';
import type { Plugin } from 'vite';

// Node's types have no global `BodyInit`, so take it from `Response` itself.
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;

export const MODE_SYNC_PREFIX = '/__dotli-mode/';

export const MODE_SYNC_CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Private Network Access rejects cross-subdomain loopback requests without it, and the host then cannot read its
  // own settings.
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
};

const modeStore = new Map<string, string>();

/** Returns the plugin that serves the store from a dev server. */
export function modeSync(): Plugin {
  return {
    name: 'dotli-mode-sync',
    apply: 'serve',
    configureServer(server) {
      // Connect strips the mount path, so `incoming.url` starts at the key.
      server.middlewares.use(MODE_SYNC_PREFIX, (incoming, outgoing, next) => {
        const method = incoming.method ?? 'GET';
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const path = (incoming.url ?? '/').split('?')[0] ?? '/';
        const request = new Request(`http://localhost${MODE_SYNC_PREFIX}`, {
          method,
          // Node's web stream is not the DOM's `ReadableStream` an app's DOM types expect, though `Request` takes it.
          body: hasBody ? (Readable.toWeb(incoming) as BodyInit) : undefined,
          duplex: hasBody ? 'half' : undefined,
          // The DOM's `RequestInit` lacks `duplex`, which Node needs for a streamed body.
        } as RequestInit);
        handleModeSync(request, decodeURIComponent(path.slice(1)))
          .then(async response => {
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(await response.text());
          })
          .catch(next);
      });
    },
  };
}

/**
 * Answers a store request for `key`: raw text both ways, with 204 for no value so GET and PUT agree on encoding.
 * DELETE on the bare prefix is the per-test reset. Rejects only when a PUT's body cannot be read.
 */
export async function handleModeSync(request: Request, key: string): Promise<Response> {
  const empty = (status: number): Response => new Response(null, { status, headers: MODE_SYNC_CORS });

  if (request.method === 'OPTIONS') {
    return empty(204);
  }

  if (request.method === 'DELETE') {
    if (key === '') {
      modeStore.clear();
    } else {
      modeStore.delete(key);
    }
    return empty(204);
  }

  if (key === '') {
    return new Response('Missing key', { status: 400, headers: MODE_SYNC_CORS });
  }

  if (request.method === 'GET') {
    const value = modeStore.get(key);
    return value === undefined
      ? empty(204)
      : new Response(value, { headers: { ...MODE_SYNC_CORS, 'Content-Type': 'text/plain' } });
  }
  if (request.method === 'PUT') {
    modeStore.set(key, await request.text());
    return empty(204);
  }
  return new Response('Method not allowed', { status: 405, headers: MODE_SYNC_CORS });
}
