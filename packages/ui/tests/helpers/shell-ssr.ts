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
// It compiles in dev posture, not the production posture of the host build's
// render server: inside a Vitest worker, `dev: false` resolves the production
// @solidjs/web server build against the development solid-js runtime, and
// the two do not fit together. The shell HTML is the same in both postures
// (compared byte for byte on the host build's output).

import { resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { createServer } from "vite";

const UI_ROOT = resolve(import.meta.dirname, "../..");

/** Server-renders the host shell exactly as the build-time prerender does. */
export async function renderShellOnServer(): Promise<string> {
  // A middleware-mode-only Vite server, never listening on a port.
  const server = await createServer({
    configFile: false,
    root: UI_ROOT,
    logLevel: "warn",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    plugins: [solid({ ssr: true })],
    resolve: { alias: { "@dotli/ui": resolve(UI_ROOT, "src") } },
  });
  try {
    const mod = await server.ssrLoadModule(
      resolve(UI_ROOT, "src/components/shell/shell.server.tsx"),
    );
    const renderShell = mod.renderShell as () => string;
    return renderShell();
  } finally {
    await server.close();
  }
}
