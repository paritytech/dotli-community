// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A prerender whose component throws must fail the build with the
// component's own error. Checked against Solid's production server build,
// the one the host build's render server uses: it is the one that sanitizes
// errors (the development build passes them through unchanged).

import { resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const UI_ROOT = resolve(import.meta.dirname, "../..");

async function renderBrokenInProduction(): Promise<unknown> {
  // A middleware-mode-only Vite server, never listening on a port. Solid is
  // bundled rather than left to Node, so these conditions pick its
  // production server build.
  const server = await createServer({
    configFile: false,
    root: UI_ROOT,
    mode: "production",
    logLevel: "warn",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    plugins: [solid({ ssr: true, dev: false })],
    resolve: { alias: { "@dotli/ui": resolve(UI_ROOT, "src") } },
    ssr: {
      noExternal: ["solid-js", "@solidjs/web", "@solidjs/signals"],
      resolve: { conditions: ["solid", "node", "import", "module", "default"] },
    },
  });
  try {
    const mod = await server.ssrLoadModule(
      resolve(import.meta.dirname, "fixtures/throwing.server.tsx"),
    );
    const renderBroken = mod.renderBroken as () => string;
    try {
      renderBroken();
    } catch (err) {
      return err;
    }
    return undefined;
  } finally {
    await server.close();
  }
}

describe("renderHydratableToString", () => {
  it("As a developer, a prerender whose component throws fails with that component's error, not a sanitized one", async () => {
    // When
    const thrown = await renderBrokenInProduction();

    // Then
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "the shell is broken: missing store default",
    );
  });
});
