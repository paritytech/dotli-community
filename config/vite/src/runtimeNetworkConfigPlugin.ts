// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Injected only on opt-in, so hosted builds do not carry the hook at all. The reader side is gated separately in
// network.ts, so neither half alone enables it. Every local server sends this script as the container's nginx does.

import type { Plugin } from 'vite';

/** The path of the config script, which nginx serves from the container's generated file. */
export const RUNTIME_NETWORK_CONFIG_PATH = '/dotli-network.js';

/**
 * The config script's headers, as the container's nginx sends them. The config can name private RPC endpoints, so it is
 * same-origin only, with no CORS and no private network grant. no-store, so a restart with a new config applies at once.
 */
export const RUNTIME_NETWORK_CONFIG_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/javascript',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/**
 * The script body for `raw`, the text of `$DOTLI_NETWORK`. Unset or blank keeps the built-in networks. Throws on text
 * that is not JSON, so a server reads it once at start and refuses to run instead of failing its first request.
 * Every server must answer the path, or an SPA fallback sends HTML the browser runs as JavaScript.
 */
export function runtimeNetworkConfigScriptBody(raw: string | undefined): string {
  const trimmed = raw?.trim();
  const config = trimmed === undefined || trimmed === '' ? '{}' : trimmed;
  // Parsed only to fail early on a typo. The original text is served.
  try {
    JSON.parse(config);
  } catch (err) {
    throw new Error('DOTLI_NETWORK is not valid JSON', { cause: err });
  }
  return `window.__DOTLI_NETWORK__ = ${config};\n`;
}

/** A blocking classic script, so the global is set before the module bundle runs and every reader stays synchronous. */
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
    // nginx serves this path in the container. Under `vite dev` nothing else would.
    configureServer(server) {
      if (!enabled) {
        return;
      }
      const body = runtimeNetworkConfigScriptBody(process.env['DOTLI_NETWORK']);
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== RUNTIME_NETWORK_CONFIG_PATH) {
          next();
          return;
        }
        // Vite's own CORS middleware runs first and allows loopback origins, which this script must not.
        res.removeHeader('Access-Control-Allow-Origin');
        for (const [name, value] of Object.entries(RUNTIME_NETWORK_CONFIG_HEADERS)) {
          res.setHeader(name, value);
        }
        res.end(body);
      });
    },
  };
}
