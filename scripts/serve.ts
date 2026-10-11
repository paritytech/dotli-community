// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The release tarball's server for environments without Docker. Node builtins only, so the bundled serve.mjs runs
// under node and bun.
// Keep the serving rules in sync with nginx/nginx.docker.conf.template by hand. The headers are why this exists:
// sandbox isolation depends on frame-ancestors and COEP.
// Binds loopback by default because the bundle only works over `*.localhost`, so remote use goes through a tunnel.

import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { runtimeNetworkConfigScriptBody } from '@config/vite/runtime-network-config';

const PORT = Number(process.env['PORT'] ?? '5173');
const HOST = process.env['HOST'] ?? '127.0.0.1';
const DIST = resolve(process.env['DIST'] ?? 'dist');
const RUNTIME_CONFIG_PATH = '/dotli-network.js';

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
  '.txt': 'text/plain',
  '.scale': 'application/octet-stream',
  '.map': 'application/json',
};

/** Mirrors the nginx profile's server blocks. */
function routeFor(hostHeader: string): { dir: string; iframeable: boolean; root: string } {
  const hostname = (hostHeader.split(':')[0] ?? '').toLowerCase();
  if (hostname === 'host.localhost') {
    return { dir: join(DIST, 'protocol'), iframeable: true, root: 'index.html' };
  }
  if (hostname.includes('.app.')) {
    return { dir: join(DIST, 'app'), iframeable: true, root: 'index.html' };
  }
  // The bare host's root is the landing page, as nginx's `location = /` serves it.
  const bare = !hostname.endsWith('.localhost');
  return { dir: join(DIST, 'host'), iframeable: false, root: bare ? 'landing.html' : 'index.html' };
}

/** Split as nginx/snippets/docker/dotli-headers-*.conf does. */
function securityHeaders(iframeable: boolean): Record<string, string> {
  const shared = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
  };
  if (!iframeable) {
    return { ...shared, 'X-Frame-Options': 'SAMEORIGIN' };
  }
  return {
    ...shared,
    // Ports matter: CSP host-sources without one mean the scheme's default.
    'Content-Security-Policy': 'frame-ancestors http://localhost:* http://*.localhost:*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/** Matches dotli-assets-*.conf and dotli-sw-*.conf. */
function cacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (pathname === '/host-sw.js' || pathname === '/app-sw.js') {
    return 'no-cache';
  }
  return 'no-cache';
}

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
  iframeable: boolean,
  acceptEncoding: string,
): void {
  const chosen = negotiate(filePath, acceptEncoding);
  const headers: Record<string, string> = {
    // From the requested file, not its .br or .gz sibling.
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': cacheControl(pathname),
    ...securityHeaders(iframeable),
  };
  if (chosen.encoding !== undefined) {
    headers['Content-Encoding'] = chosen.encoding;
    headers['Vary'] = 'Accept-Encoding';
  }
  if (pathname === '/host-sw.js' || pathname === '/app-sw.js') {
    headers['Service-Worker-Allowed'] = '/';
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

for (const sub of ['host', 'app', 'protocol']) {
  if (!existsSync(join(DIST, sub))) {
    console.error(
      `serve: ${join(DIST, sub)} not found.\n` +
        `Expected ${DIST} to contain host/, app/ and protocol/.\n` +
        `Set DIST=<path> if the bundle is elsewhere.`,
    );
    process.exit(1);
  }
}

createServer((req, res) => {
  const { dir, iframeable, root } = routeFor(req.headers.host ?? '');
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const acceptEncoding = req.headers['accept-encoding'] ?? '';
  const accept = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;

  // Ahead of the SPA fallback, whose index.html would fail as a script syntax error rather than a missing file.
  if (url.pathname === RUNTIME_CONFIG_PATH) {
    const body = runtimeNetworkConfigScriptBody();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      ...securityHeaders(iframeable),
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
    send(res, candidate, url.pathname, iframeable, accept);
    return;
  }

  const page = requested === '/' ? root : 'index.html';
  const index = join(dir, page);
  if (isFile(index)) {
    send(res, index, `/${page}`, iframeable, accept);
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
