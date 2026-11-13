// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What depends on the local roots is built once from the roots a server is given, so its routes and headers agree.

import type { IncomingMessage } from 'node:http';
import { extname } from 'node:path';
import type { Plugin } from 'vite';
import { getFileHeaders } from './getFileHeaders.ts';
import { getHeaderPolicy, type HeaderPolicy } from './getHeaderPolicy.ts';
import { getPolicyHeaders, UNFRAMED_HEADERS } from './getPolicyHeaders.ts';
import { getRequestHostname } from './getRequestHostname.ts';
import { isProtocolPath, type Route } from './siteRoutes.ts';

/** The routes and headers of a local server, which answers under its local roots. */
export type LocalServing = Readonly<ReturnType<typeof createLocalServing>>;

type Params = {
  /** The file sent, whose extension gives the type, so a .br or .gz sibling's original keeps it. */
  filePath: string;
  /** The path its caching headers follow. */
  pathname: string;
  /** The header policy of the request. */
  policy: HeaderPolicy;
};

/**
 * Chrome's Private Network Access blocks loopback iframes across a local root's subdomains without it. A deploy serves
 * public origins and needs none.
 */
const LOCAL_SERVER_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Private-Network': 'true',
};

/** The Content-Type a local server sends for each file extension. */
const MIME_TYPES: Readonly<Record<string, string>> = {
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

/** Returns the routes and headers of a local server that answers under `roots`. Never throws. */
export function createLocalServing(roots: readonly string[]) {
  // Ports matter: CSP host-sources without one mean the scheme's default.
  const frameAncestors = ['http:', 'https:']
    .flatMap(scheme => roots.flatMap(root => [`${scheme}//${root}:*`, `${scheme}//*.${root}:*`]))
    .join(' ');

  function getRoute(hostname: string, pathname: string): Route {
    const name = hostname.toLowerCase();
    const root = roots.find(local => name.endsWith(`.${local}`));
    // On a product or sandbox host the path is the product's own.
    if (root === undefined && isProtocolPath(pathname)) {
      return { site: 'protocol', bare: false };
    }
    if (root !== undefined && name.endsWith(`.app.${root}`)) {
      return { site: 'app', bare: false };
    }
    return { site: 'host', bare: root === undefined };
  }

  function getSecurityHeaders(policy: HeaderPolicy): Record<string, string> {
    return getPolicyHeaders(policy, frameAncestors);
  }

  function getResponseHeaders({ filePath, pathname, policy }: Params): Record<string, string> {
    return {
      'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      ...getFileHeaders(pathname),
      ...getSecurityHeaders(policy),
      ...LOCAL_SERVER_HEADERS,
    };
  }

  function getDevHeaders(hostname: string, pathname: string): Record<string, string> {
    const policy = getHeaderPolicy(getRoute(hostname, pathname), pathname);
    switch (policy) {
      case 'isolated':
        return getSecurityHeaders(policy);
      case 'unframed':
        return { ...UNFRAMED_HEADERS };
      case 'worker-coep':
      case 'plain':
        return {};
    }
  }

  function isolationHeaders(): Plugin {
    return {
      name: 'dotli-isolation-headers',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = (request.url ?? '/').split('?')[0] ?? '/';
          for (const [name, value] of Object.entries(getDevHeaders(getRequestHostname(request.headers), pathname))) {
            response.setHeader(name, value);
          }
          next();
        });
      },
    };
  }

  function getProtocolProxyBypass(request: Pick<IncomingMessage, 'url' | 'headers'>): string | undefined {
    const url = request.url ?? '/';
    const route = getRoute(getRequestHostname(request.headers), url.split('?')[0] ?? '/');
    return route.site === 'protocol' ? undefined : url;
  }

  return {
    /**
     * Returns the build a local hostname and path reach. Never throws. The protocol app answers under its prefix on the
     * bare host. Any host but a local root's subdomain is the bare host.
     */
    getRoute,
    /** Every local root and its subdomains, on any port and scheme, which an isolated page lets frame it. */
    frameAncestors,
    /**
     * Returns a new object holding the security headers of `policy`, with the local roots as an isolated page's frame
     * ancestors. Never throws.
     */
    getSecurityHeaders,
    /** Returns a new object holding everything a local server sends with a file. Never throws. */
    getResponseHeaders,
    /**
     * Returns what a dev server adds to its own headers for a request: the isolated headers on the routes this table
     * isolates, the frame refusal on the session windows, and nothing elsewhere. Never throws. Server-wide, COEP would
     * break the localhost dev servers, which ship no CORP.
     */
    getDevHeaders,
    /** Returns a dev server plugin that sets the headers `getDevHeaders` gives on every response. Never throws. */
    isolationHeaders,
    /**
     * Returns `undefined` for a request this table routes to the protocol build, and the request's URL for any other,
     * as a dev server proxy's `bypass` option takes it. Never throws.
     */
    getProtocolProxyBypass,
  };
}
