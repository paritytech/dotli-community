// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Real server output of components/shell/shell.server.tsx, for tests.
//
// renderShell() calls @solidjs/web's renderToString, which throws when
// resolved through Vitest's own (browser-conditioned) module graph - the same
// reason apps/host/vite.config.ts's prerender plugin needs a real Vite SSR
// server rather than a plain `import`. This builds that same kind of
// throwaway SSR-only server, so tests exercise the real @solidjs/vite-plugin
// SSR compile, not a stand-in.
//
// It compiles with the host build's Solid options (apps/host/vite.config.ts),
// so the markup is what the build puts in index.html.

import { resolve } from 'node:path';
import solid from '@solidjs/vite-plugin';
import { createServer } from 'vite';

const UI_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Loads the server entry `entry` (a path under packages/ui) the way the
 * build-time prerender does and returns what its `render` export renders.
 */
async function renderOnServer(entry: string, render: string): Promise<string> {
  // A middleware-mode-only Vite server, never listening on a port.
  const server = await createServer({
    configFile: false,
    root: UI_ROOT,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    // The host build's Solid options.
    plugins: [solid({ ssr: true, solid: { hydratable: false } })],
    resolve: { alias: { '@dotli/ui': resolve(UI_ROOT, 'src') } },
  });
  try {
    const mod = await server.ssrLoadModule(resolve(UI_ROOT, entry));
    return (mod[render] as () => string)();
  } finally {
    await server.close();
  }
}

/** Server-renders the host shell exactly as the build-time prerender does. */
export function renderShellOnServer(): Promise<string> {
  return renderOnServer('src/components/shell/shell.server.tsx', 'renderShell');
}
