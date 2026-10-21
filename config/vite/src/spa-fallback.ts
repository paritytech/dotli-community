// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { routeFor } from './serving.ts';

/** A request as the dev server's middleware sees it. */
export interface PageRequest {
  method: string | undefined;
  url: string | undefined;
  accept: string | undefined;
  host: string | undefined;
}

/** What the dev server does with a request before Astro answers it. */
export type FallbackAction = { kind: 'pass' } | { kind: 'rewrite'; url: string } | { kind: 'not-found' };

/**
 * Routes page loads as nginx does: the bare host's root to `landing`, and any other path that names no public file to
 * the shell page. A malformed escape names no file, so it is a 404, as the release and test servers answer it.
 */
export function fallbackFor(
  req: PageRequest,
  landing: string,
  isPublicFile: (path: string) => boolean,
): FallbackAction {
  const isPageLoad = (req.method === 'GET' || req.method === 'HEAD') && (req.accept ?? '').includes('text/html');
  if (!isPageLoad) {
    return { kind: 'pass' };
  }
  const [path = '/', query] = (req.url ?? '/').split('?');
  const withQuery = (page: string): string => (query === undefined ? page : `${page}?${query}`);
  if (path === '/') {
    const hostname = (req.host ?? '').split(':')[0] ?? '';
    return routeFor(hostname).bare ? { kind: 'rewrite', url: withQuery(landing) } : { kind: 'pass' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { kind: 'not-found' };
  }
  return isPublicFile(decoded) ? { kind: 'pass' } : { kind: 'rewrite', url: withQuery('/') };
}

/** `astro dev` answers unknown paths with 404, which breaks product deep links and `/__preview`. */
export function spaFallback({ landing }: { landing: string }): Plugin {
  return {
    name: 'dotli-spa-fallback',
    apply: 'serve',
    configureServer(server) {
      const isPublicFile = (path: string): boolean => existsSync(join(server.config.publicDir, path));
      server.middlewares.use((req, res, next) => {
        const action = fallbackFor(
          { method: req.method, url: req.url, accept: req.headers.accept, host: req.headers.host },
          landing,
          isPublicFile,
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
