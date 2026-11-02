// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Preview server for the Playwright suites: every build on one port, routed by hostname.
// Binds loopback by default, so nobody on the LAN reads the build. A phone check sets `HOST=0.0.0.0`.

import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { MODE_SYNC_CORS, MODE_SYNC_PREFIX, handleModeSync } from '@config/vite/mode-sync';
import {
  RUNTIME_NETWORK_CONFIG_HEADERS,
  RUNTIME_NETWORK_CONFIG_PATH,
  createRuntimeNetworkConfigBody,
} from '@config/vite/runtime-network-config';
import { createLocalServing, getHeaderPolicy, getPathInBuild, resolveFile, type Site } from '@config/vite/serving';
import { LOCAL_ROOTS } from '@dotli/config/local-roots';

// Node's types have no global `BodyInit`, so take it from `Response` itself.
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;

// Read once, so a $DOTLI_NETWORK that is not JSON stops the server at start instead of failing its first request.
const RUNTIME_CONFIG_BODY = createRuntimeNetworkConfigBody(process.env['DOTLI_NETWORK']);

const PORT = parseInt(process.env['PORT'] ?? '5173', 10);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const serving = createLocalServing(LOCAL_ROOTS);
const ROOT = join(import.meta.dirname, '..');
const DIRS: Record<Site, string> = {
  host: join(ROOT, 'apps/host/dist'),
  app: join(ROOT, 'apps/sandbox/dist'),
  protocol: join(ROOT, 'apps/protocol/dist'),
};

const REQUIRED_BUILDS: readonly string[] = ['Host', 'App (sandbox)'];
for (const [label, dir] of [
  ['Host', DIRS.host],
  ['App (sandbox)', DIRS.app],
  ['Protocol', DIRS.protocol],
] as const) {
  if (existsSync(dir)) {
    continue;
  }
  if (REQUIRED_BUILDS.includes(label)) {
    console.error(`${label} build not found at ${dir}\nRun: npm run build (from monorepo root)`);
    process.exit(1);
  }
  console.warn(`⚠ ${label} build not found at ${dir}. Requests to this origin will 404`);
}

// The Sentry tunnel sink, the only way a test can observe what the SharedWorker reports. Playwright route
// interception misses SharedWorker requests.
const METRICS_PATH = '/__dotli-metrics';
const TUNNEL_PATH = '/t';
const gaugePoints: { name: string; value: number; mode: string }[] = [];

// Metric names carry the `dotli.` prefix but attribute keys do not, and attribute values are wrapped as
// `{ value, type }`.
function readAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const wrapped = attributes[key];
  return isRecord(wrapped) && typeof wrapped['value'] === 'string' ? wrapped['value'] : undefined;
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
      // A line that is not JSON is skipped, so a malformed envelope never answers with a non-200.
      continue;
    }
    for (const item of readEnvelopeItems(parsed)) {
      if (!isRecord(item)) {
        continue;
      }
      const name = item['name'];
      if (typeof name !== 'string' || !name.startsWith('dotli.')) {
        continue;
      }
      const attributes = isRecord(item['attributes']) ? item['attributes'] : {};
      gaugePoints.push({
        name,
        value: typeof item['value'] === 'number' ? item['value'] : 0,
        mode: readAttribute(attributes, 'protocol_mode') ?? '',
      });
    }
  }
}

function readEnvelopeItems(envelope: unknown): unknown[] {
  if (!isRecord(envelope)) {
    return [];
  }
  const items: unknown = envelope['items'];
  return Array.isArray(items) ? items : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function handleMetrics(request: Request): Response {
  const headers = { ...MODE_SYNC_CORS, 'Content-Type': 'application/json' };
  if (request.method === 'DELETE') {
    gaugePoints.length = 0;
    return new Response(null, { status: 204, headers: MODE_SYNC_CORS });
  }
  return new Response(JSON.stringify(gaugePoints), { headers });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === TUNNEL_PATH) {
    collectEnvelope(await request.text());
    return new Response(null, { status: 200, headers: MODE_SYNC_CORS });
  }

  if (url.pathname === METRICS_PATH) {
    return handleMetrics(request);
  }

  if (url.pathname.startsWith(MODE_SYNC_PREFIX)) {
    const key = decodeURIComponent(url.pathname.slice(MODE_SYNC_PREFIX.length));
    return handleModeSync(request, key);
  }

  // Ahead of the SPA fallback, whose index.html would fail as a script syntax error rather than a missing file.
  if (url.pathname === RUNTIME_NETWORK_CONFIG_PATH) {
    return new Response(RUNTIME_CONFIG_BODY, { headers: RUNTIME_NETWORK_CONFIG_HEADERS });
  }

  const route = serving.getRoute(url.hostname, url.pathname);
  const resolved = resolveFile({ dir: DIRS[route.site], route, pathname: getPathInBuild(route, url.pathname) });
  if (resolved === undefined) {
    return new Response('Not Found', { status: 404 });
  }
  // Node's `toWeb` returns a stream of `any` chunks, and a file stream yields bytes.
  const body = Readable.toWeb(createReadStream(resolved.file)) as ReadableStream<Uint8Array>;
  const headers = serving.getResponseHeaders({
    filePath: resolved.file,
    pathname: resolved.pathname,
    policy: getHeaderPolicy(route, url.pathname),
  });
  // Node's web stream type is not the one `Response` names, though they are the same object at runtime.
  return new Response(body as BodyInit, { headers });
}

// The Request URL takes its hostname from the Host header, which the routing keys on.
async function respond(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const headerValue of Array.isArray(value) ? value : [value]) {
      headers.append(name, headerValue);
    }
  }
  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const request = new Request(`http://${incoming.headers.host ?? 'localhost'}${incoming.url ?? '/'}`, {
    method,
    headers,
    // Node's web stream type is not the one `Request` names, though they are the same object at runtime.
    ...(hasBody ? { body: Readable.toWeb(incoming) as BodyInit, duplex: 'half' as const } : {}),
  });
  const response = await handleRequest(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null || method === 'HEAD') {
    outgoing.end();
    return;
  }
  // The body is the web stream `Response` names, which `fromWeb` takes as Node's own type.
  Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(outgoing);
}

createServer((incoming, outgoing) => {
  void respond(incoming, outgoing).catch((error: unknown) => {
    console.error(error);
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
