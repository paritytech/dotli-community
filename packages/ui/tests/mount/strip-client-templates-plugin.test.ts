// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's client module must not carry its DOM template strings (they
// are only used to client-render, and the shell never is; see
// mount/strip-client-templates-plugin.ts), while the SSR compile that
// prerenders it must keep them. Both are checked on the real
// @solidjs/vite-plugin output, compiled the way the host build compiles it.

import { resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { build, createServer, type Rolldown, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  stripClientTemplates,
  stripClientTemplatesPlugin,
} from "@dotli/ui/mount/strip-client-templates-plugin";

const UI_ROOT = resolve(import.meta.dirname, "../..");
const SHELL = resolve(UI_ROOT, "src/components/shell/Shell.tsx");
const OTHER_COMPONENT = resolve(
  UI_ROOT,
  "src/components/chat/ResizeHandle.tsx",
);

/**
 * Production client build of `entry` with the shell plugins; returns the
 * bundled JavaScript.
 */
async function buildClient(entry: string): Promise<string> {
  const output = (await build({
    configFile: false,
    root: UI_ROOT,
    logLevel: "silent",
    plugins: [
      solid({ ssr: true }),
      stripClientTemplatesPlugin({ files: [SHELL] }),
    ],
    resolve: { alias: { "@dotli/ui": resolve(UI_ROOT, "src") } },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        // Keep the entry's exports, so the shell is not tree-shaken away.
        preserveEntrySignatures: "strict",
      },
    },
  })) as Rolldown.RolldownOutput;
  return output.output
    .map((file) => (file.type === "chunk" ? file.code : ""))
    .join("\n");
}

/** Markup that only a template string (or the SSR output) contains. */
const SHELL_MARKUP = ["topbar-logo", "<svg", "auth-modal-backdrop"];

describe("stripClientTemplatesPlugin", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    // A middleware-mode-only Vite server, never listening on a port.
    server = await createServer({
      configFile: false,
      root: UI_ROOT,
      logLevel: "warn",
      appType: "custom",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      plugins: [
        solid({ ssr: true }),
        stripClientTemplatesPlugin({ files: [SHELL] }),
      ],
      resolve: { alias: { "@dotli/ui": resolve(UI_ROOT, "src") } },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  async function compile(
    environment: "client" | "ssr",
    file: string,
  ): Promise<string> {
    const result =
      await server.environments[environment].transformRequest(file);
    return result?.code ?? "";
  }

  it("As the host's startup bundle, the shell's client module has no template strings, only its hydration claims", async () => {
    // When
    const code = await compile("client", SHELL);

    // Then
    for (const markup of SHELL_MARKUP) {
      expect(code).not.toContain(markup);
    }
    expect(code).not.toMatch(/_\$template\(/);
    expect(code.match(/_\$getNextElement\(/g)).toHaveLength(7);
  });

  it("As the build-time prerender, the shell's SSR compile keeps its markup", async () => {
    // When
    const code = await compile("ssr", SHELL);

    // Then
    for (const markup of SHELL_MARKUP) {
      expect(code).toContain(markup);
    }
  });

  it("As any other component, my client templates are left alone", async () => {
    // When
    const code = await compile("client", OTHER_COMPONENT);

    // Then
    expect(code).toMatch(/_\$template\(`</);
  });
});

describe("stripClientTemplatesPlugin in a production build", () => {
  it("As the host's startup bundle, a client build that bundles the shell ships none of its markup", async () => {
    // When
    const code = await buildClient("fixtures/shell-entry.ts");

    // Then
    expect(code).toMatch(/function Shell\(/);
    for (const markup of SHELL_MARKUP) {
      expect(code).not.toContain(markup);
    }
  });

  it("As a build, a listed file the client build never compiles fails the build instead of shipping its templates again", async () => {
    // When / Then
    await expect(buildClient("fixtures/plain-entry.ts")).rejects.toThrow(
      /never compiled .*Shell\.tsx/,
    );
  });
});

describe("stripClientTemplates", () => {
  it("As a build, a component with reactive Solid imports fails instead of losing the templates it renders from", () => {
    // Given
    const code = [
      'import { template as _$template, getNextElement as _$getNextElement, insert as _$insert } from "@solidjs/web";',
      "var _tmpl$ = _$template(`<p>`);",
      "export const P = (props) => { const el = _$getNextElement(_tmpl$); _$insert(el, () => props.text); return el; };",
    ].join("\n");

    // When / Then
    expect(() => stripClientTemplates(code, "P.tsx")).toThrow(
      /imports "insert"/,
    );
  });

  it("As a build, reactive imports from a Solid subpath export fail too, while HMR registration is allowed", () => {
    // Given
    const code = (source: string, name: string) =>
      [
        'import { template as _$template, getNextElement as _$getNextElement } from "@solidjs/web";',
        `import { ${name} as _$x } from "${source}";`,
        "var _tmpl$ = _$template(`<p>`);",
        "export const P = () => [_$getNextElement(_tmpl$), _$x];",
      ].join("\n");

    // When / Then
    expect(() =>
      stripClientTemplates(code("solid-js/store", "createStore"), "P.tsx"),
    ).toThrow(/imports "createStore" from solid-js\/store/);
    expect(() =>
      stripClientTemplates(code("solid-js/refresh", "$$registry"), "P.tsx"),
    ).not.toThrow();
  });

  it("As a build, a template spanning lines keeps its line breaks, so later lines keep their numbers", () => {
    // Given
    const code = [
      'import { template as _$template, getNextElement as _$getNextElement } from "@solidjs/web";',
      "var _tmpl$ = _$template(`<p>one",
      "two`);",
      "export const P = () => _$getNextElement(_tmpl$);",
    ].join("\n");

    // When
    const stripped = stripClientTemplates(code, "P.tsx");

    // Then
    expect(stripped.split("\n")).toEqual([
      'import { template as _$template, getNextElement as _$getNextElement } from "@solidjs/web";',
      "var _tmpl$ = undefined",
      ";",
      "export const P = () => _$getNextElement(_tmpl$);",
    ]);
  });

  it("As a build, a non-hydratable compile fails instead of rendering empty nodes", () => {
    // Given
    const code = [
      'import { template as _$template } from "@solidjs/web";',
      "var _tmpl$ = _$template(`<p>hi`);",
      "export const P = () => _tmpl$();",
    ].join("\n");

    // When / Then
    expect(() => stripClientTemplates(code, "P.tsx")).toThrow(
      /not a hydratable compile/,
    );
  });

  it("As a build, each template() call becomes undefined and everything else is kept, including non-ASCII text before it", () => {
    // Given
    const code = [
      'import { template as _$template, getNextElement as _$getNextElement } from "@solidjs/web";',
      'const label = "Connecting…";',
      "var _tmpl$ = /* @__PURE__ */ _$template(`<p>one`), _tmpl$2 = /* @__PURE__ */ _$template(`<p>two`);",
      "export const P = () => [_$getNextElement(_tmpl$), _$getNextElement(_tmpl$2), label];",
    ].join("\n");

    // When
    const stripped = stripClientTemplates(code, "P.tsx");

    // Then
    expect(stripped.split("\n")).toEqual([
      'import { template as _$template, getNextElement as _$getNextElement } from "@solidjs/web";',
      'const label = "Connecting…";',
      "var _tmpl$ = /* @__PURE__ */ undefined, _tmpl$2 = /* @__PURE__ */ undefined;",
      "export const P = () => [_$getNextElement(_tmpl$), _$getNextElement(_tmpl$2), label];",
    ]);
  });
});
