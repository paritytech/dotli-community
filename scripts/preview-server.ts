// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Preview server for the Playwright suites: every build on one port, routed by hostname as nginx does.
// Binds loopback by default, so nobody on the LAN reads the build. A phone check sets `HOST=0.0.0.0`.

import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { MODE_SYNC_CORS, MODE_SYNC_PREFIX, handleModeSync } from '@config/vite/mode-sync';
import {
  RUNTIME_NETWORK_CONFIG_HEADERS,
  RUNTIME_NETWORK_CONFIG_PATH,
  runtimeNetworkConfigScriptBody,
} from '@config/vite/runtime-network-config';
import { headerPolicy, resolveFile, responseHeaders, routeFor, type Site } from '@config/vite/serving';

// Node's types have no global `BodyInit`, so take it from `Response` itself.
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;

// Read once, so a $DOTLI_NETWORK that is not JSON stops the server at start instead of failing its first request.
const runtimeConfigBody = runtimeNetworkConfigScriptBody(process.env['DOTLI_NETWORK']);

const PORT = parseInt(process.env['PORT'] ?? '5173', 10);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const ROOT = join(import.meta.dirname, '..');
const DIRS: Record<Site, string> = {
  host: join(ROOT, 'apps/host/dist'),
  app: join(ROOT, 'apps/sandbox/dist'),
  protocol: join(ROOT, 'apps/protocol/dist'),
};

const REQUIRED_BUILDS = ['Host', 'App (sandbox)'] as const;
for (const [label, dir] of [
  ['Host', DIRS.host],
  ['App (sandbox)', DIRS.app],
  ['Protocol', DIRS.protocol],
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
  if (url.pathname === RUNTIME_NETWORK_CONFIG_PATH) {
    return new Response(runtimeConfigBody, { headers: RUNTIME_NETWORK_CONFIG_HEADERS });
  }

  const route = routeFor(url.hostname);
  const resolved = resolveFile(DIRS[route.site], route, url.pathname);
  if (resolved === undefined) {
    return new Response('Not Found', { status: 404 });
  }
  const body = Readable.toWeb(createReadStream(resolved.file)) as ReadableStream<Uint8Array>;
  const headers = responseHeaders(resolved.file, resolved.pathname, headerPolicy(route, url.pathname));
  return new Response(body as BodyInit, { headers });
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
}).listen(PORT, HOST);

console.log(`Preview server on http://localhost:${String(PORT)} (bound ${HOST})`);
console.log(`  Host: ${DIRS.host}`);
console.log(`  App:  ${DIRS.app}`);
console.log(`  Protocol: ${DIRS.protocol}`);
