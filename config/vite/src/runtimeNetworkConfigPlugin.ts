// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Injected only on opt-in, so hosted builds do not carry the hook. The reader is gated on its own, so neither half
// alone enables it.

import type { Plugin } from 'vite';

/** The path of the config script at a site's root. */
export const RUNTIME_NETWORK_CONFIG_PATH = '/dotli-network.js';

/**
 * The config script's headers. The config can name private RPC endpoints, so it is same-origin only, with no CORS and
 * no private network grant. no-store, so a restart with a new config applies at once.
 */
export const RUNTIME_NETWORK_CONFIG_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/javascript',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/**
 * Returns the plugin that injects the config script on opt-in, as a blocking classic script, so the global is set
 * before the module bundle runs and every reader stays synchronous. Its dev server fails to start when
 * `$DOTLI_NETWORK` is not JSON.
 */
export function runtimeNetworkConfigScript(): Plugin {
  const enabled = process.env['VITE_RUNTIME_NETWORK_CONFIG'] === 'true';
  return {
    name: 'dotli-runtime-network-config',
    transformIndexHtml() {
      if (!enabled) {
        return [];
      }
      return [
        {
          tag: 'script',
          attrs: { src: RUNTIME_NETWORK_CONFIG_PATH },
          injectTo: 'head-prepend' as const,
        },
      ];
    },
    configureServer(server) {
      if (!enabled) {
        return;
      }
      const body = createRuntimeNetworkConfigBody(process.env['DOTLI_NETWORK']);
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== RUNTIME_NETWORK_CONFIG_PATH) {
          next();
          return;
        }
        // Vite's own CORS middleware runs first and allows loopback origins, which this script must not.
        response.removeHeader('Access-Control-Allow-Origin');
        for (const [name, value] of Object.entries(RUNTIME_NETWORK_CONFIG_HEADERS)) {
          response.setHeader(name, value);
        }
        response.end(body);
      });
    },
  };
}

/**
 * Returns the script body for `raw`, the text of `$DOTLI_NETWORK`. Unset or blank keeps the built-in networks. Throws
 * on text that is not JSON, so a server reads it once at start and refuses to run instead of failing its first request.
 * Every server must answer the path, or an SPA fallback sends HTML the browser runs as JavaScript.
 */
export function createRuntimeNetworkConfigBody(raw: string | undefined): string {
  const trimmed = raw?.trim();
  const config = trimmed === undefined || trimmed === '' ? '{}' : trimmed;
  // Parsed only to fail early on a typo. The original text is served.
  try {
    JSON.parse(config);
  } catch (error) {
    throw new Error(`DOTLI_NETWORK is not valid JSON: ${config}`, { cause: error });
  }
  return `window.__DOTLI_NETWORK__ = ${config};\n`;
}
