// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Preview server for the Playwright suites: every build on one port, routed by hostname as nginx does.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { runtimeNetworkConfigScriptBody } from '@config/vite/runtime-network-config';

// Node's types have no global `BodyInit`, so take it from `Response` itself.
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;

const RUNTIME_CONFIG_PATH = '/dotli-network.js';

const PORT = parseInt(process.env['PORT'] ?? '5173', 10);
const ROOT = join(import.meta.dirname, '..');
const HOST_DIR = join(ROOT, 'apps/host/dist');
const APP_DIR = join(ROOT, 'apps/sandbox/dist');
const PROTOCOL_DIR = join(ROOT, 'apps/protocol/dist');

const REQUIRED_BUILDS = ['Host', 'App (sandbox)'] as const;
for (const [label, dir] of [
  ['Host', HOST_DIR],
  ['App (sandbox)', APP_DIR],
  ['Protocol', PROTOCOL_DIR],
] as const) {
  if (!existsSync(dir)) {
    const isRequired = (REQUIRED_BUILDS as readonly string[]).includes(label);
    if (isRequired) {
      console.error(`${label} build not found at ${dir}\nRun: npm run build (from monorepo root)`);
      process.exit(1);
    }
    console.warn(`⚠ ${label} build not found at ${dir} — requests to this origin will 404`);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.scale': 'application/octet-stream',
  '.map': 'application/json',
};

function serveFile(filePath: string, coep: boolean): Response | null {
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Service-Worker-Allowed': '/',
    'Access-Control-Allow-Origin': '*',
    // Chrome's Private Network Access blocks loopback iframes across *.localhost subdomains without it, so the
    // protocol bridge handshake times out.
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-cache',
  };
  if (coep) {
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  }
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body as BodyInit, { headers });
}

// Production shares mode preferences through the `host.<BASE_DOMAIN>` iframe's localStorage, but on localhost every
// subdomain is its own site and Chrome partitions that storage per embedder.
const modeStore = new Map<string, string>();
const MODE_SYNC_PREFIX = '/__dotli-mode/';
const MODE_SYNC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Private Network Access rejects cross-subdomain loopback requests without it, and the host then cannot read its
  // own settings.
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
};

// Raw text both ways, with 204 for no value so GET and PUT agree on encoding. DELETE on the bare prefix is the
// per-test reset.
async function handleModeSync(req: Request, key: string): Promise<Response> {
  const ok = (body: BodyInit | null, contentType?: string): Response => {
    const headers: Record<string, string> = { ...MODE_SYNC_CORS };
    if (contentType !== undefined) {
      headers['Content-Type'] = contentType;
    }
    return new Response(body, { status: body === null ? 204 : 200, headers });
  };
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
    return new Response('Missing key', {
      status: 400,
      headers: MODE_SYNC_CORS,
    });
  }

  if (req.method === 'GET') {
    const value = modeStore.get(key);
    return value === undefined ? empty(204) : ok(value, MIME['.txt']);
  }
  if (req.method === 'PUT') {
    modeStore.set(key, await req.text());
    return empty(204);
  }
  return new Response('Method not allowed', {
    status: 405,
    headers: MODE_SYNC_CORS,
  });
}

// The Sentry tunnel sink, the only way a test can observe what the SharedWorker reports. Playwright route
// interception misses SharedWorker requests.
const METRICS_PATH = '/__dotli-metrics';
const TUNNEL_PATH = '/t';
const gaugePoints: { name: string; value: number; mode: string }[] = [];

// A malformed envelope line must never become a non-200, or measuring changes the app's behaviour. Metric names
// carry the `dotli.` prefix but attribute keys do not, and attribute values are wrapped as `{ value, type }`.
function readAttr(attrs: Record<string, unknown>, key: string): string | undefined {
  const wrapped = attrs[key] as { value?: unknown } | undefined;
  return typeof wrapped?.value === 'string' ? wrapped.value : undefined;
}

function collectEnvelope(body: string): void {
  for (const line of body.split('\n')) {
    if (line === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items as Record<string, unknown>[]) {
      const name = item['name'];
      if (typeof name !== 'string' || !name.startsWith('dotli.')) {
        continue;
      }
      const attrs = (item['attributes'] ?? {}) as Record<string, unknown>;
      gaugePoints.push({
        name,
        value: typeof item['value'] === 'number' ? item['value'] : 0,
        mode: readAttr(attrs, 'protocol_mode') ?? '',
      });
    }
  }
}

function handleMetrics(req: Request): Response {
  const headers = { ...MODE_SYNC_CORS, 'Content-Type': 'application/json' };
  if (req.method === 'DELETE') {
    gaugePoints.length = 0;
    return new Response(null, { status: 204, headers: MODE_SYNC_CORS });
  }
  return new Response(JSON.stringify(gaugePoints), { headers });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === TUNNEL_PATH) {
    collectEnvelope(await req.text());
    return new Response(null, { status: 200, headers: MODE_SYNC_CORS });
  }

  if (url.pathname === METRICS_PATH) {
    return handleMetrics(req);
  }

  if (url.pathname.startsWith(MODE_SYNC_PREFIX)) {
    const key = decodeURIComponent(url.pathname.slice(MODE_SYNC_PREFIX.length));
    return handleModeSync(req, key);
  }

  // Ahead of the SPA fallback, whose index.html would fail as a script syntax error rather than a missing file.
  if (url.pathname === RUNTIME_CONFIG_PATH) {
    return new Response(runtimeNetworkConfigScriptBody(), {
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-store',
      },
    });
  }

  const isProtocol = url.hostname === 'host.localhost';
  const isApp = url.hostname.includes('.app.');
  const baseDir = isProtocol ? PROTOCOL_DIR : isApp ? APP_DIR : HOST_DIR;
  const fallback = 'index.html';

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') {
    pathname = `/${fallback}`;
  }

  // As nginx does. COEP on the rest of the host build would block the /localhost:<port> proxy iframe.
  const coep = isApp || isProtocol || pathname.startsWith('/__preview');

  const exact = join(baseDir, pathname);
  const res = serveFile(exact, coep);
  if (res) {
    return res;
  }

  const res2 = serveFile(join(exact, 'index.html'), coep);
  if (res2) {
    return res2;
  }

  return serveFile(join(baseDir, fallback), coep) ?? new Response('Not Found', { status: 404 });
}

// The Request URL takes its hostname from the Host header, which the routing keys on.
createServer((incoming, outgoing) => {
  void (async () => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined) {
        continue;
      }
      for (const v of Array.isArray(value) ? value : [value]) {
        headers.append(name, v);
      }
    }
    const method = incoming.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const req = new Request(`http://${incoming.headers.host ?? 'localhost'}${incoming.url ?? '/'}`, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(incoming) as BodyInit) : undefined,
      duplex: hasBody ? 'half' : undefined,
    } as RequestInit);
    const res = await handle(req);
    outgoing.writeHead(res.status, Object.fromEntries(res.headers));
    if (res.body === null || method === 'HEAD') {
      outgoing.end();
      return;
    }
    Readable.fromWeb(res.body as ReadableStream<Uint8Array>).pipe(outgoing);
  })().catch((err: unknown) => {
    console.error(err);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500);
    }
    outgoing.end();
  });
}).listen(PORT, '0.0.0.0');

console.log(`Preview server on http://localhost:${String(PORT)}`);
console.log(`  Host: ${HOST_DIR}`);
console.log(`  App:  ${APP_DIR}`);
console.log(`  Protocol: ${PROTOCOL_DIR}`);
