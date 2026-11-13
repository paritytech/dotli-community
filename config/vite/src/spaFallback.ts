// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { LocalServing } from './createLocalServing.ts';
import { getRequestHostname } from './getRequestHostname.ts';
import { isSessionPath } from './siteRoutes.ts';

/** The pages the bare host answers with other than the shell, by their Astro routes. */
export type FallbackPages = {
  /** The bare host's root. */
  landing: string;
  /** The session window, which the bare host's `/s/auth`, `/s/signout`, `/s/manage` and `/s/sign` answer with. */
  session: string;
};

/** A request as the dev server's middleware sees it. */
export type PageRequest = {
  /** The HTTP method. */
  method: string | undefined;
  /** The request target, path and query. */
  url: string | undefined;
  /** The `Accept` header. */
  accept: string | undefined;
  /** The hostname the request names. */
  hostname: string;
};

/** What the dev server does with a request before Astro answers it. */
export type FallbackAction = { kind: 'pass' } | { kind: 'rewrite'; url: string } | { kind: 'not-found' };

type Params = {
  /** The request to route. */
  request: PageRequest;
  /** The pages the bare host answers with. */
  pages: FallbackPages;
  /** Whether a decoded path names a file in the public folder. */
  isPublicFile: (path: string) => boolean;
  /** The build a hostname and path reach, which tells the bare host from the others. */
  getRoute: LocalServing['getRoute'];
};

/**
 * Returns the dev server middleware that rewrites a page load to the bare host's pages or the shell, and answers a
 * malformed escape with 404. Never throws. `astro dev` answers unknown paths with 404, which breaks product deep links
 * and `/__preview`. `serving` tells the bare host from the others.
 */
export function spaFallback(pages: FallbackPages, serving: LocalServing): Plugin {
  return {
    name: 'dotli-spa-fallback',
    apply: 'serve',
    configureServer(server) {
      const isPublicFile = (path: string): boolean => existsSync(join(server.config.publicDir, path));
      server.middlewares.use((request, response, next) => {
        const action = getFallbackAction({
          request: {
            method: request.method,
            url: request.url,
            accept: request.headers.accept,
            hostname: getRequestHostname(request.headers),
          },
          pages,
          isPublicFile,
          getRoute: serving.getRoute,
        });
        switch (action.kind) {
          case 'not-found':
            response.statusCode = 404;
            response.end('Not Found');
            return;
          case 'rewrite':
            request.url = action.url;
            next();
            return;
          case 'pass':
            next();
            return;
        }
      });
    },
  };
}

/**
 * Returns what to do with a request. Never throws. Routes page loads: the bare host's root to `landing`, its `/s/auth`,
 * `/s/signout`, `/s/manage` and `/s/sign` to `session`, and any other path that names no public file to the shell
 * page. A malformed escape names no file, so it is a 404.
 */
export function getFallbackAction({ request, pages, isPublicFile, getRoute }: Params): FallbackAction {
  const isPageLoad =
    (request.method === 'GET' || request.method === 'HEAD') && (request.accept ?? '').includes('text/html');
  if (!isPageLoad) {
    return { kind: 'pass' };
  }
  const [path = '/', query] = (request.url ?? '/').split('?');
  const appendQuery = (page: string): string => (query === undefined ? page : `${page}?${query}`);
  const route = getRoute(request.hostname, path);
  // A protocol frame load is not this server's page to answer.
  if (route.site === 'protocol') {
    return { kind: 'pass' };
  }
  if (path === '/') {
    return route.bare ? { kind: 'rewrite', url: appendQuery(pages.landing) } : { kind: 'pass' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape names no file, so it is a 404 rather than a server error.
    return { kind: 'not-found' };
  }
  if (isSessionPath(route, path)) {
    return { kind: 'rewrite', url: appendQuery(pages.session) };
  }
  return isPublicFile(decoded) ? { kind: 'pass' } : { kind: 'rewrite', url: appendQuery('/') };
}
