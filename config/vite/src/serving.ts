// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How every local dotli server answers: which build serves a hostname, and the headers each response carries, split as
// nginx's snippets are. The release server, the test server and the dev servers read it, and its spec holds nginx's
// snippets to it, so the functional tests run under the same sandbox isolation as a deploy.

import { extname } from 'node:path';

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
 * `isolated` is a cross-origin isolated or embeddable page. `worker-coep` is a host asset, whose worker script must
 * carry COEP itself or the isolated /__preview page cannot start it.
 */
export type HeaderPolicy = 'isolated' | 'worker-coep' | 'plain';

/** COEP on the host's other documents would block the localhost proxy iframe, so only /__preview is isolated there. */
export function headerPolicy(route: Route, pathname: string): HeaderPolicy {
  if (route.site !== 'host' || (route.bare && pathname === '/__preview')) {
    return 'isolated';
  }
  return pathname.startsWith('/assets/') ? 'worker-coep' : 'plain';
}

/** Ports matter: CSP host-sources without one mean the scheme's default. */
export const LOCAL_FRAME_ANCESTORS = 'http://localhost:* http://*.localhost:*';

/**
 * Chrome's Private Network Access blocks loopback iframes across `*.localhost` subdomains without it, so the protocol
 * frame's handshake times out. nginx serves public origins and needs none.
 */
export const LOCAL_SERVER_HEADERS: Readonly<Record<string, string>> = {
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
