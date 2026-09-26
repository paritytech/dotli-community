// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A prerender whose component throws, at any depth, must fail the build with
// the component's own error. Checked against Solid's production server
// build, the one the host build's render server uses (it is the one that
// sanitizes errors), and the development build the tests' SSR helper uses.

import { resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderOnServer } from "../helpers/shell-ssr";

const UI_ROOT = resolve(import.meta.dirname, "../..");

const ENTRY = "tests/mount/fixtures/throwing.server.tsx";

/** Renders `name` from the fixture entry in production posture. */
async function renderInProduction(name: string): Promise<string> {
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
    return (mod[name] as () => string)();
  } finally {
    await server.close();
  }
}

async function thrownBy(render: Promise<string>): Promise<unknown> {
  try {
    await render;
  } catch (err) {
    return err;
  }
  return undefined;
}

const POSTURES = {
  production: renderInProduction,
  development: (name: string) => renderOnServer(ENTRY, name),
};

describe("renderHydratableToString", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("As a developer, a prerender whose root component throws fails with that component's error, not a sanitized one", async () => {
    // When
    const thrown = await thrownBy(renderInProduction("renderBroken"));

    // Then
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "the shell is broken: missing store default",
    );
  });

  for (const [posture, render] of Object.entries(POSTURES)) {
    it.each([
      ["a child component", "renderBrokenChild", "broken-child"],
      [
        "a nested child inside its own boundary",
        "renderBrokenInBoundary",
        "broken-in-boundary",
      ],
    ])(
      `As a developer (${posture} build), a prerender where %s throws below the root fails with that error instead of shipping a serialized one`,
      async (_what, name, renderId) => {
        // Given
        // Solid's development build logs each contained error
        // (SSR_RENDER_ERROR_CONTAINED); expected here.
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});

        // When
        const thrown = await thrownBy(render(name));

        // Then
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(`render "${renderId}"`);
        expect((thrown as Error).message).toContain(
          "a child is broken: missing store default",
        );
        expect(((thrown as Error).cause as Error).message).toBe(
          "a child is broken: missing store default",
        );
      },
    );

    it(`As a developer (${posture} build), a prerender that throws nowhere renders its markup with no script`, async () => {
      // When
      const html = await render("renderClean");

      // Then
      expect(html.match(/>fine<\/span>/g)).toHaveLength(2);
      expect(html).toContain('id="bar"');
      expect(html).not.toContain("<script");
    });
  }
});
