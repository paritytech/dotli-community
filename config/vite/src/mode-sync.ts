// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Production shares mode preferences through the `host.<BASE_DOMAIN>` iframe's localStorage, but on localhost every
// subdomain is its own site and Chrome partitions that storage per embedder. Local servers keep them in memory instead,
// on the protocol origin.

import { Readable } from 'node:stream';
import type { Plugin } from 'vite';

// Node's types have no global `BodyInit`, so take it from `Response` itself.
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;

export const MODE_SYNC_PREFIX = '/__dotli-mode/';

export const MODE_SYNC_CORS: Record<string, string> = {
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

/**
 * Raw text both ways, with 204 for no value so GET and PUT agree on encoding. DELETE on the bare prefix is the
 * per-test reset.
 */
export async function handleModeSync(req: Request, key: string): Promise<Response> {
  const empty = (status: number): Response => new Response(null, { status, headers: MODE_SYNC_CORS });

  if (req.method === 'OPTIONS') {
    return empty(204);
  }

  if (req.method === 'DELETE') {
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

  if (req.method === 'GET') {
    const value = modeStore.get(key);
    return value === undefined
      ? empty(204)
      : new Response(value, { headers: { ...MODE_SYNC_CORS, 'Content-Type': 'text/plain' } });
  }
  if (req.method === 'PUT') {
    modeStore.set(key, await req.text());
    return empty(204);
  }
  return new Response('Method not allowed', { status: 405, headers: MODE_SYNC_CORS });
}

/** Serves the store from a dev server, as the preview server does. */
export function modeSync(): Plugin {
  return {
    name: 'dotli-mode-sync',
    apply: 'serve',
    configureServer(server) {
      // Connect strips the mount path, so `req.url` starts at the key.
      server.middlewares.use(MODE_SYNC_PREFIX, (incoming, outgoing, next) => {
        const method = incoming.method ?? 'GET';
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const path = (incoming.url ?? '/').split('?')[0] ?? '/';
        const req = new Request(`http://localhost${MODE_SYNC_PREFIX}`, {
          method,
          body: hasBody ? (Readable.toWeb(incoming) as BodyInit) : undefined,
          duplex: hasBody ? 'half' : undefined,
        } as RequestInit);
        handleModeSync(req, decodeURIComponent(path.slice(1)))
          .then(async res => {
            outgoing.writeHead(res.status, Object.fromEntries(res.headers));
            outgoing.end(await res.text());
          })
          .catch(next);
      });
    },
  };
}
