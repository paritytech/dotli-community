// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { isProtocolPath, isSessionPath, requestHostname, type LocalServing } from './serving.ts';

/** The pages the bare host answers with other than the shell, by their Astro routes. */
export type FallbackPages = {
  /** The bare host's root. */
  landing: string;
  /**
   * The session window, which the bare host's `/s/auth`, `/s/signout`, `/s/manage` and `/s/sign` answer with. It is
   * one built file, `session.html`, that only these paths may serve.
   */
  session: string;
};

/** A request as the dev server's middleware sees it. */
export type PageRequest = {
  method: string | undefined;
  url: string | undefined;
  accept: string | undefined;
  hostname: string;
};

/** What the dev server does with a request before Astro answers it. */
export type FallbackAction = { kind: 'pass' } | { kind: 'rewrite'; url: string } | { kind: 'not-found' };

/**
 * Routes page loads: the bare host's root to `landing`, its `/s/auth`, `/s/signout`, `/s/manage` and `/s/sign` to
 * `session`, and any other path that names no public file to the shell page. A malformed escape names no file, so it is
 * a 404. `routeFor` tells the bare host from the others.
 */
export function fallbackFor(
  req: PageRequest,
  pages: FallbackPages,
  isPublicFile: (path: string) => boolean,
  routeFor: LocalServing['routeFor'],
): FallbackAction {
  const isPageLoad = (req.method === 'GET' || req.method === 'HEAD') && (req.accept ?? '').includes('text/html');
  if (!isPageLoad) {
    return { kind: 'pass' };
  }
  const [path = '/', query] = (req.url ?? '/').split('?');
  const withQuery = (page: string): string => (query === undefined ? page : `${page}?${query}`);
  const route = routeFor(req.hostname, path);
  // The dev server hands the protocol frame to the protocol app's dev server.
  if (isProtocolPath(path) && route.site === 'protocol') {
    return { kind: 'pass' };
  }
  if (path === '/') {
    return route.bare ? { kind: 'rewrite', url: withQuery(pages.landing) } : { kind: 'pass' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { kind: 'not-found' };
  }
  if (isSessionPath(route, path)) {
    return { kind: 'rewrite', url: withQuery(pages.session) };
  }
  return isPublicFile(decoded) ? { kind: 'pass' } : { kind: 'rewrite', url: withQuery('/') };
}

/**
 * `astro dev` answers unknown paths with 404, which breaks product deep links and `/__preview`. `serving` tells the
 * bare host from the others.
 */
export function spaFallback(pages: FallbackPages, serving: LocalServing): Plugin {
  return {
    name: 'dotli-spa-fallback',
    apply: 'serve',
    configureServer(server) {
      const isPublicFile = (path: string): boolean => existsSync(join(server.config.publicDir, path));
      server.middlewares.use((req, res, next) => {
        const action = fallbackFor(
          { method: req.method, url: req.url, accept: req.headers.accept, hostname: requestHostname(req.headers) },
          pages,
          isPublicFile,
          serving.routeFor,
        );
        if (action.kind === 'not-found') {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        if (action.kind === 'rewrite') {
          req.url = action.url;
        }
        next();
      });
    },
  };
}
