// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  injectPrerendered,
  prerenderPlugin,
} from "@dotli/ui/mount/prerender-plugin";

const PLACEHOLDER = "<!--ssr:shell-->";

// prerender-plugin.ts only ever calls `createServer` on the "no dev server"
// (production build) path; everything else in this file exercises the
// "ctx.server already exists" (dev server) path or throws before either is
// reached, so mocking it doesn't touch those.
const vite = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("vite", () => vite);

/** The subset of `ResolvedConfig` the plugin's `configResolved` hook reads. */
interface FakeResolvedConfig {
  command: "build" | "serve";
  configFile: string | undefined;
  inlineConfig: Record<string, unknown>;
  root: string;
  mode: string;
}

interface FakeServer {
  ssrLoadModule: (id: string) => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
}

/** The subset of `IndexHtmlTransformContext` the plugin's handler reads. */
interface FakeIndexHtmlTransformContext {
  path: string;
  filename: string;
  server?: FakeServer;
}

function callConfigResolved(
  plugin: ReturnType<typeof prerenderPlugin>,
  config: FakeResolvedConfig,
): void {
  const hook = plugin.configResolved as unknown as (
    config: FakeResolvedConfig,
  ) => void;
  hook(config);
}

function callTransformIndexHtml(
  plugin: ReturnType<typeof prerenderPlugin>,
  html: string,
  ctx: FakeIndexHtmlTransformContext,
): Promise<string> {
  const { handler } = plugin.transformIndexHtml as unknown as {
    handler: (
      html: string,
      ctx: FakeIndexHtmlTransformContext,
    ) => Promise<string>;
  };
  return handler(html, ctx);
}

describe("injectPrerendered", () => {
  it("As the build output, the placeholder is replaced by the rendered HTML verbatim", () => {
    // Given
    const html = `<body><div id="shell">${PLACEHOLDER}</div><div id="app"></div></body>`;
    const rendered = `<span>a $& b $1</span>`;

    // When
    const result = injectPrerendered(html, PLACEHOLDER, rendered);

    // Then
    expect(result).toBe(
      `<body><div id="shell">${rendered}</div><div id="app"></div></body>`,
    );
  });

  it("As a missing placeholder would ship an empty shell, it fails loudly", () => {
    // Given
    const html = `<body><div id="shell"></div></body>`;

    // When / Then
    expect(() => injectPrerendered(html, PLACEHOLDER, "<span></span>")).toThrow(
      /placeholder "<!--ssr:shell-->" not found/,
    );
  });

  it("As a duplicated placeholder is ambiguous, it fails loudly", () => {
    // Given
    const html = `<body>${PLACEHOLDER}<div>${PLACEHOLDER}</div></body>`;

    // When / Then
    expect(() => injectPrerendered(html, PLACEHOLDER, "<span></span>")).toThrow(
      /placeholder "<!--ssr:shell-->" appears 2 times/,
    );
  });
});

describe("prerenderPlugin", () => {
  it("As a missing entry would silently ship an empty shell, configResolved fails loudly", () => {
    // Given
    const plugin = prerenderPlugin({
      placeholder: PLACEHOLDER,
      entry: "/definitely/does/not/exist/shell.server.tsx",
      exportName: "renderShell",
    });

    // When / Then
    expect(() => {
      callConfigResolved(plugin, {
        command: "serve",
        configFile: "/repo/apps/host/vite.config.ts",
        inlineConfig: {},
        root: "/repo/apps/host",
        mode: "development",
      });
    }).toThrow(/entry not found/);
  });

  it("As a build, the shell is rendered by a short-lived render server, which is closed afterwards", async () => {
    // Given
    const close = vi.fn().mockResolvedValue(undefined);
    vite.createServer.mockResolvedValue({
      ssrLoadModule: () =>
        Promise.resolve({ renderShell: () => `<div id="topbar"></div>` }),
      close,
    });
    const plugin = prerenderPlugin({
      placeholder: PLACEHOLDER,
      entry: import.meta.filename,
      exportName: "renderShell",
    });
    callConfigResolved(plugin, {
      command: "build",
      configFile: "/repo/apps/host/vite.config.ts",
      inlineConfig: {},
      root: "/repo/apps/host",
      mode: "production",
    });

    // When
    const result = await callTransformIndexHtml(
      plugin,
      `<body>${PLACEHOLDER}</body>`,
      { path: "/index.html", filename: "index.html" },
    );

    // Then
    expect(result).toBe(`<body><div id="topbar"></div></body>`);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("As an empty render would ship an empty shell, it fails loudly instead", async () => {
    // Given
    const plugin = prerenderPlugin({
      placeholder: PLACEHOLDER,
      entry: "/fake/shell.server.tsx",
      exportName: "renderShell",
    });
    const server: FakeServer = {
      ssrLoadModule: () => Promise.resolve({ renderShell: () => "   " }),
    };

    // When / Then
    await expect(
      callTransformIndexHtml(plugin, `<body>${PLACEHOLDER}</body>`, {
        path: "/index.html",
        filename: "index.html",
        server,
      }),
    ).rejects.toThrow(/returned an empty string/);
  });

  it("As only the host's index.html carries the shell, other HTML entries pass through untouched", async () => {
    // Given
    const plugin = prerenderPlugin({
      placeholder: PLACEHOLDER,
      entry: "/fake/shell.server.tsx",
      exportName: "renderShell",
    });
    const ssrLoadModule = vi.fn();
    const html = `<body>not the shell entry</body>`;

    // When
    const result = await callTransformIndexHtml(plugin, html, {
      path: "/preview/index.html",
      filename: "/repo/apps/host/dist/__preview/some-other-page.html",
      server: { ssrLoadModule },
    });

    // Then
    expect(result).toBe(html);
    expect(ssrLoadModule).not.toHaveBeenCalled();
  });

  it("As a build resolves without a configFile, the inner render server would start with no plugins - it fails loudly instead", () => {
    // Given
    const plugin = prerenderPlugin({
      placeholder: PLACEHOLDER,
      entry: import.meta.filename,
      exportName: "renderShell",
    });

    // When / Then
    expect(() => {
      callConfigResolved(plugin, {
        command: "build",
        configFile: undefined,
        inlineConfig: {},
        root: "/repo/apps/host",
        mode: "production",
      });
    }).toThrow(/no configFile resolved/);
  });

  it("As the inner server also fails to close after a render error, the render error still surfaces and the close failure is only logged", async () => {
    // Given
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      /* asserted on below, not printed */
    });
    vite.createServer.mockResolvedValue({
      ssrLoadModule: () => Promise.reject(new Error("boom-render")),
      close: () => Promise.reject(new Error("boom-close")),
    });
    const plugin = prerenderPlugin({
      placeholder: PLACEHOLDER,
      entry: import.meta.filename,
      exportName: "renderShell",
    });
    callConfigResolved(plugin, {
      command: "build",
      configFile: "/repo/apps/host/vite.config.ts",
      inlineConfig: {},
      root: "/repo/apps/host",
      mode: "production",
    });

    // When / Then
    await expect(
      callTransformIndexHtml(plugin, `<body>${PLACEHOLDER}</body>`, {
        path: "/index.html",
        filename: "index.html",
      }),
    ).rejects.toThrow("boom-render");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("server.close() also failed"),
      expect.objectContaining({ message: "boom-close" }),
    );

    consoleError.mockRestore();
  });
});
