// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Injected only on opt-in, so hosted builds do not carry the hook at all. The reader side is gated separately in
// network.ts, so neither half alone enables it.

import type { Plugin } from 'vite';

/** Path nginx serves from the container's generated config. */
const SCRIPT_SRC = '/dotli-network.js';

/**
 * The script body, from the same `$DOTLI_NETWORK` the container entrypoint reads.
 * Every server must serve this path, or an SPA fallback answers with HTML the browser runs as JavaScript.
 */
export function runtimeNetworkConfigScriptBody(): string {
  const raw = process.env['DOTLI_NETWORK']?.trim();
  const config = raw === undefined || raw === '' ? '{}' : raw;
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
          attrs: { src: SCRIPT_SRC },
          injectTo: 'head-prepend' as const,
        },
      ];
    },
    // nginx serves this path in the container. Under `vite dev` nothing else would.
    configureServer(server) {
      if (!enabled) {
        return;
      }
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== SCRIPT_SRC) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(runtimeNetworkConfigScriptBody());
      });
    },
  };
}
