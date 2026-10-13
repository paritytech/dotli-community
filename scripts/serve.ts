// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The release tarball's server for environments without Docker. Node builtins only, so the bundled serve.mjs runs
// under node and bun.
// Routes and headers come from the shared serving table, which a spec holds to nginx's snippets. Sandbox isolation
// depends on them.
// Binds loopback by default because the bundle only works over `*.localhost`, so remote use goes through a tunnel.

import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { runtimeNetworkConfigScriptBody } from '@config/vite/runtime-network-config';
import {
  LOCAL_SERVER_HEADERS,
  headerPolicy,
  responseHeaders,
  rootPage,
  routeFor,
  securityHeaders,
  type HeaderPolicy,
  type Site,
} from '@config/vite/serving';

const PORT = Number(process.env['PORT'] ?? '5173');
const HOST = process.env['HOST'] ?? '127.0.0.1';
const DIST = resolve(process.env['DIST'] ?? 'dist');
const RUNTIME_CONFIG_PATH = '/dotli-network.js';

const DIRS: Record<Site, string> = {
  host: join(DIST, 'host'),
  app: join(DIST, 'app'),
  protocol: join(DIST, 'protocol'),
};

/** Matches `brotli_static` and `gzip_static`. Brotli first, as the smaller. */
function negotiate(filePath: string, acceptEncoding: string): { path: string; encoding?: string } {
  if (acceptEncoding.includes('br') && existsSync(`${filePath}.br`)) {
    return { path: `${filePath}.br`, encoding: 'br' };
  }
  if (acceptEncoding.includes('gzip') && existsSync(`${filePath}.gz`)) {
    return { path: `${filePath}.gz`, encoding: 'gzip' };
  }
  return { path: filePath };
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function send(
  res: ServerResponse,
  filePath: string,
  pathname: string,
  policy: HeaderPolicy,
  acceptEncoding: string,
): void {
  const chosen = negotiate(filePath, acceptEncoding);
  const headers = responseHeaders(filePath, pathname, policy);
  if (chosen.encoding !== undefined) {
    headers['Content-Encoding'] = chosen.encoding;
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  createReadStream(chosen.path).pipe(res);
}

if (PORT === 80) {
  console.error(
    "serve: PORT=80 is not supported — the bundle derives the protocol iframe's\n" +
      'origin from window.location.port, which browsers leave empty on port 80, so\n' +
      'the iframe would be looked for on port 5173 and never load. Use another port.',
  );
  process.exit(1);
}

for (const dir of Object.values(DIRS)) {
  if (!existsSync(dir)) {
    console.error(
      `serve: ${dir} not found.\n` +
        `Expected ${DIST} to contain host/, app/ and protocol/.\n` +
        `Set DIST=<path> if the bundle is elsewhere.`,
    );
    process.exit(1);
  }
}

createServer((req, res) => {
  const route = routeFor((req.headers.host ?? '').split(':')[0] ?? '');
  const dir = DIRS[route.site];
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const acceptEncoding = req.headers['accept-encoding'] ?? '';
  const accept = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;

  const policy = headerPolicy(route, url.pathname);

  // Ahead of the SPA fallback, whose index.html would fail as a script syntax error rather than a missing file.
  if (url.pathname === RUNTIME_CONFIG_PATH) {
    const body = runtimeNetworkConfigScriptBody();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      ...securityHeaders(policy),
      ...LOCAL_SERVER_HEADERS,
    });
    res.end(body);
    return;
  }

  // `normalize` then confine to `dir`, so `..` cannot escape the bundle.
  const requested = normalize(decodeURIComponent(url.pathname));
  const candidate = join(dir, requested);
  if (!candidate.startsWith(dir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (requested !== '/' && isFile(candidate)) {
    send(res, candidate, url.pathname, policy, accept);
    return;
  }

  const page = requested === '/' ? rootPage(route) : 'index.html';
  const index = join(dir, page);
  if (isFile(index)) {
    send(res, index, `/${page}`, policy, accept);
    return;
  }
  res.writeHead(404).end('Not Found');
}).listen(PORT, HOST, () => {
  const config = process.env['DOTLI_NETWORK']?.trim();
  console.log(`dot.li serving ${DIST} on http://localhost:${String(PORT)} (bound ${HOST})`);
  console.log(`  shell     http://browse.localhost:${String(PORT)}`);
  console.log(`  protocol  http://host.localhost:${String(PORT)}`);
  console.log(
    `  network   ${config === undefined || config === '' ? 'built-in (set DOTLI_NETWORK to override)' : config}`,
  );
});
