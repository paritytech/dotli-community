// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Routes page loads as nginx does: the bare host's root to `landing`, and any other path that names no public file to
 * the shell page. `astro dev` answers those with 404, which breaks product deep links and `/__preview`.
 */
export function spaFallback({ landing }: { landing: string }): Plugin {
  return {
    name: 'dotli-spa-fallback',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path = '/', query] = (req.url ?? '/').split('?');
        const isPageLoad =
          (req.method === 'GET' || req.method === 'HEAD') && (req.headers.accept ?? '').includes('text/html');
        const hostname = (req.headers.host ?? '').split(':')[0] ?? '';
        const withQuery = (page: string): string => (query === undefined ? page : `${page}?${query}`);
        if (isPageLoad && path === '/' && !hostname.endsWith('.localhost')) {
          req.url = withQuery(landing);
        } else if (isPageLoad && path !== '/' && !existsSync(join(server.config.publicDir, decodeURIComponent(path)))) {
          req.url = withQuery('/');
        }
        next();
      });
    },
  };
}
