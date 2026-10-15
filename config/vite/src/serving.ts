// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How every local dotli server answers: which build serves a hostname, which file answers a path, and the headers each
// response carries, split as nginx's snippets are. The release server, the test server and the dev servers read it, and
// its spec holds nginx's snippets to it, so the functional tests run under the same sandbox isolation as a deploy.

import { statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Plugin } from 'vite';

/** The three builds, each on its own origin. */
export type Site = 'host' | 'app' | 'protocol';

export interface Route {
  site: Site;
  /** The bare host, whose root is the landing page. */
  bare: boolean;
}

/** The build a local hostname reaches, as nginx's server blocks route a domain. */
export function routeFor(hostname: string): Route {
  const name = hostname.toLowerCase();
  if (name === 'host.localhost') {
    return { site: 'protocol', bare: false };
  }
  if (name.includes('.app.')) {
    return { site: 'app', bare: false };
  }
  return { site: 'host', bare: !name.endsWith('.localhost') };
}

/** The file that answers `/`. */
export function rootPage(route: Route): string {
  return route.bare ? 'landing.html' : 'index.html';
}

/**
 * `isolated` is a cross-origin isolated or embeddable page. `worker-coep` is a bare-host asset, whose worker script must
 * carry COEP itself or the isolated /__preview page cannot start it.
 */
export type HeaderPolicy = 'isolated' | 'worker-coep' | 'plain';

/**
 * COEP on the host's other documents would block the localhost proxy iframe, so only /__preview is isolated there.
 * Its workers come from the bare host's /assets/, which carry COEP for it.
 */
export function headerPolicy(route: Route, pathname: string): HeaderPolicy {
  if (route.site !== 'host' || (route.bare && pathname === '/__preview')) {
    return 'isolated';
  }
  return route.bare && pathname.startsWith('/assets/') ? 'worker-coep' : 'plain';
}

/** Ports matter: CSP host-sources without one mean the scheme's default. */
export const LOCAL_FRAME_ANCESTORS = 'http://localhost:* http://*.localhost:*';

/**
 * Chrome's Private Network Access blocks loopback iframes across `*.localhost` subdomains without it, so the protocol
 * frame's handshake times out. nginx serves public origins and needs none.
 */
const LOCAL_SERVER_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Private-Network': 'true',
};

/** The security headers of `policy`. `frameAncestors` fills an isolated page's CSP, nginx's `$csp_ancestors`. */
export function securityHeaders(
  policy: HeaderPolicy,
  frameAncestors: string = LOCAL_FRAME_ANCESTORS,
): Record<string, string> {
  const shared = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (policy !== 'isolated') {
    const plain = { ...shared, 'X-Frame-Options': 'SAMEORIGIN' };
    return policy === 'worker-coep' ? { ...plain, 'Cross-Origin-Embedder-Policy': 'credentialless' } : plain;
  }
  return {
    ...shared,
    'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/**
 * The isolated headers on the routes this table isolates, for the dev servers. Server-wide, COEP would break the
 * localhost dev servers, which ship no CORP.
 */
export function isolationHeaders(): Plugin {
  const headers = securityHeaders('isolated');
  return {
    name: 'dotli-isolation-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '/').split('?')[0] ?? '/';
        const hostname = (req.headers.host ?? '').split(':')[0] ?? '';
        if (headerPolicy(routeFor(hostname), pathname) === 'isolated') {
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }
        }
        next();
      });
    },
  };
}

const SERVICE_WORKERS: ReadonlySet<string> = new Set(['/host-sw.js', '/app-sw.js']);

/** Caching and worker scope. Asset names are content-hashed, and a worker is revalidated so an update reaches it. */
export function fileHeaders(pathname: string): Record<string, string> {
  if (pathname.startsWith('/assets/')) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  if (SERVICE_WORKERS.has(pathname)) {
    return { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' };
  }
  return { 'Cache-Control': 'no-cache' };
}

/**
 * Missing, these are a 404 rather than the shell, which a browser would try to run. nginx's exact locations answer so
 * where they exist.
 */
const NO_FALLBACK: ReadonlySet<string> = new Set([...SERVICE_WORKERS, '/host_version.json']);

/** A file a local server sends. */
export interface ResolvedFile {
  file: string;
  /** The path its caching headers follow. */
  pathname: string;
}

function isFileOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing, or a name the platform refuses, such as one holding a null byte.
    return false;
  }
}

/**
 * The file that answers `pathname` from the build in `dir`, in nginx's `try_files` order: the root page at `/`, the file
 * itself, a folder's index on the bare host, then the shell. A missing asset, worker or version file is a 404 instead.
 * `undefined` is a 404.
 */
export function resolveFile(
  dir: string,
  route: Route,
  pathname: string,
  isFile: (path: string) => boolean = isFileOnDisk,
): ResolvedFile | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape names no file.
    return undefined;
  }
  if (decoded === '/') {
    const page = rootPage(route);
    const file = join(dir, page);
    return isFile(file) ? { file, pathname: `/${page}` } : undefined;
  }
  // The leading slash makes `normalize` settle `..` against the root, so no path leaves `dir`.
  const file = join(dir, normalize(`/${decoded}`));
  if (isFile(file)) {
    return { file, pathname: decoded };
  }
  if (decoded.startsWith('/assets/') || NO_FALLBACK.has(decoded)) {
    return undefined;
  }
  if (route.bare) {
    const index = join(file, 'index.html');
    if (isFile(index)) {
      return { file: index, pathname: decoded };
    }
  }
  const shell = join(dir, 'index.html');
  return isFile(shell) ? { file: shell, pathname: '/index.html' } : undefined;
}

export const MIME_TYPES: Readonly<Record<string, string>> = {
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

/** Everything a local server sends with a file. The type comes from `filePath`, so a .br or .gz sibling keeps it. */
export function responseHeaders(filePath: string, pathname: string, policy: HeaderPolicy): Record<string, string> {
  return {
    'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    ...fileHeaders(pathname),
    ...securityHeaders(policy),
    ...LOCAL_SERVER_HEADERS,
  };
}
