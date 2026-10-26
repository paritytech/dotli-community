// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How every local dotli server answers: which build serves a hostname, which file answers a path, and the headers each
// response carries, by header policy. The release server, the test server and the dev servers read it, and its spec
// holds the deploy's nginx snippets to it, so the functional tests run under the same sandbox isolation as a deploy.
// What depends on the local roots is built once from the roots a server is given, so its routes and headers agree.

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

/** The protocol app's path, which reaches the protocol build on every origin. */
export const PROTOCOL_PREFIX = '/__protocol';

/** The hostname a request names. HTTP/2, which the https dev servers speak, carries it as `:authority`, not `Host`. */
export function requestHostname(headers: Readonly<Record<string, string | string[] | undefined>>): string {
  const authority = headers['host'] ?? headers[':authority'];
  return (typeof authority === 'string' ? authority : '').split(':')[0] ?? '';
}

/** Whether `pathname` is under the protocol app's prefix, which reaches the protocol build on any host. */
export function isProtocolPath(pathname: string): boolean {
  return pathname.startsWith(`${PROTOCOL_PREFIX}/`);
}

/**
 * Maps `pathname` to its path in the route's build. The protocol build's files sit at its root, its base adds the
 * prefix, and `host.` under a local root asks for them without it.
 */
export function pathInBuild(route: Route, pathname: string): string {
  return route.site === 'protocol' && isProtocolPath(pathname) ? pathname.slice(PROTOCOL_PREFIX.length) : pathname;
}

/** The sign-in window's path on the bare host, which serves the window at that exact path only. */
export const SESSION_PATH = '/__session';
const SESSION_FILE = 'session.html';
/** The window's built file, which only its path may serve, since that path is what refuses framing. */
const SESSION_FILE_PATH = `/${SESSION_FILE}`;

/** The file that answers `/`. */
export function rootPage(route: Route): string {
  return route.bare ? 'landing.html' : 'index.html';
}

/**
 * `isolated` is a cross-origin isolated or embeddable page. `worker-coep` is a bare-host asset, whose worker script
 * must carry COEP itself or the isolated /__preview page cannot start it. `unframed` is the sign-in window, which no
 * page may frame and which sends no opener policy, since that would cut its link to the page that opened it.
 */
export type HeaderPolicy = 'isolated' | 'worker-coep' | 'unframed' | 'plain';

/**
 * COEP on the host's other documents would block the localhost proxy iframe, so only /__preview is isolated there.
 * Its workers come from the bare host's /assets/, which carry COEP for it.
 */
export function headerPolicy(route: Route, pathname: string): HeaderPolicy {
  if (route.site !== 'host' || (route.bare && pathname === '/__preview')) {
    return 'isolated';
  }
  if (route.bare && pathname === SESSION_PATH) {
    return 'unframed';
  }
  return route.bare && pathname.startsWith('/assets/') ? 'worker-coep' : 'plain';
}

/**
 * Chrome's Private Network Access blocks loopback iframes across a local root's subdomains without it, so the protocol
 * frame's handshake times out. A deploy serves public origins and needs none.
 */
const LOCAL_SERVER_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Private-Network': 'true',
};

/** What no page may frame sends on top of the host build's headers. */
const UNFRAMED: Readonly<Record<string, string>> = { 'Content-Security-Policy': "frame-ancestors 'none'" };

/** The security headers of `policy`. `frameAncestors` fills an isolated page's CSP. */
export function policyHeaders(policy: HeaderPolicy, frameAncestors: string): Record<string, string> {
  const shared = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (policy !== 'isolated') {
    const plain = { ...shared, 'X-Frame-Options': 'SAMEORIGIN' };
    if (policy === 'unframed') {
      return { ...plain, ...UNFRAMED };
    }
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

/** Missing, these are a 404 rather than the shell, which a browser would try to run. */
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
 * The file that answers `pathname` from the build in `dir`, the first of: the root page at `/`, the file itself, a
 * folder's index on the bare host, then the shell. On the bare host `/__session` answers with the sign-in window's
 * page, which the host build never serves under its own file name. A missing asset, worker, session page or version
 * file is a 404 instead. `undefined` is a 404.
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
  if (route.bare && decoded === SESSION_PATH) {
    const file = join(dir, SESSION_FILE);
    return isFile(file) ? { file, pathname: decoded } : undefined;
  }
  // The leading slash makes `normalize` settle `..` against the root, so no path leaves `dir`.
  const normalized = normalize(`/${decoded}`);
  if (route.site === 'host' && normalized === SESSION_FILE_PATH) {
    return undefined;
  }
  const file = join(dir, normalized);
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

/** The routes and headers of a local server, which answers under its local roots. */
export interface LocalServing {
  /**
   * The build a local hostname and path reach. The protocol app answers under its prefix on any host, and at `host.`
   * under a local root. Any host but a local root's subdomain is the bare host.
   */
  readonly routeFor: (hostname: string, pathname: string) => Route;
  /** Every local root and its subdomains, on any port and scheme, which an isolated page lets frame it. */
  readonly frameAncestors: string;
  /** The security headers of `policy`, with the local roots as an isolated page's frame ancestors. */
  readonly securityHeaders: (policy: HeaderPolicy) => Record<string, string>;
  /** Everything a local server sends with a file. The type comes from `filePath`, so a .br or .gz sibling keeps it. */
  readonly responseHeaders: (filePath: string, pathname: string, policy: HeaderPolicy) => Record<string, string>;
  /**
   * What a dev server adds to its own headers for a request: the isolated headers on the routes this table isolates,
   * and the frame refusal on the sign-in window. Server-wide, COEP would break the localhost dev servers, which ship no
   * CORP.
   */
  readonly devHeaders: (hostname: string, pathname: string) => Record<string, string>;
  /** The dev servers' headers from `devHeaders`. */
  readonly isolationHeaders: () => Plugin;
}

/** The routes and headers of a local server that answers under `roots`. */
export function createLocalServing(roots: readonly string[]): LocalServing {
  // Ports matter: CSP host-sources without one mean the scheme's default.
  const frameAncestors = ['http:', 'https:']
    .flatMap(scheme => roots.flatMap(root => [`${scheme}//${root}:*`, `${scheme}//*.${root}:*`]))
    .join(' ');

  const routeFor = (hostname: string, pathname: string): Route => {
    if (isProtocolPath(pathname)) {
      return { site: 'protocol', bare: false };
    }
    const name = hostname.toLowerCase();
    const root = roots.find(local => name.endsWith(`.${local}`));
    // Kept for one release so a shell cached by an older release still finds its frame.
    if (root !== undefined && name === `host.${root}`) {
      return { site: 'protocol', bare: false };
    }
    if (name.includes('.app.')) {
      return { site: 'app', bare: false };
    }
    return { site: 'host', bare: root === undefined };
  };

  const securityHeaders = (policy: HeaderPolicy): Record<string, string> => policyHeaders(policy, frameAncestors);

  const devHeaders = (hostname: string, pathname: string): Record<string, string> => {
    const policy = headerPolicy(routeFor(hostname, pathname), pathname);
    if (policy === 'isolated') {
      return securityHeaders('isolated');
    }
    return policy === 'unframed' ? { ...UNFRAMED } : {};
  };

  return {
    routeFor,
    frameAncestors,
    securityHeaders,
    responseHeaders: (filePath, pathname, policy) => ({
      'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      ...fileHeaders(pathname),
      ...securityHeaders(policy),
      ...LOCAL_SERVER_HEADERS,
    }),
    devHeaders,
    isolationHeaders: () => ({
      name: 'dotli-isolation-headers',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? '/').split('?')[0] ?? '/';
          for (const [name, value] of Object.entries(devHeaders(requestHostname(req.headers), pathname))) {
            res.setHeader(name, value);
          }
          next();
        });
      },
    }),
  };
}
