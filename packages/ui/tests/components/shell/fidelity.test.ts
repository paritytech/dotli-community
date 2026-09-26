// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host shell markup is a frozen contract (imperative code in
// apps/host/src/topbar.ts, and Playwright selectors, select these ids and
// classes verbatim). This test proves that prerendering <Shell/> reproduces
// tests/components/shell/original-shell.html - the exact block that used to
// live in apps/host/index.html before it was replaced by the `#shell`
// placeholder - node for node: same elements, same attributes, same text,
// same order. Solid's hydration markers (`_hk=...`) and HTML comments are
// not part of that contract, so both are stripped before comparing.
//
// renderShell() calls @solidjs/web's renderToString, which throws when
// resolved through Vitest's own (browser-conditioned) module graph - the
// same reason apps/host/vite.config.ts's prerender plugin needs a real Vite
// SSR server rather than a plain `import`. This test builds that same kind
// of throwaway SSR-only server directly, so it exercises the real
// @solidjs/vite-plugin SSR compile, not a stand-in.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

const UI_ROOT = resolve(import.meta.dirname, "../../..");
const FIXTURE_PATH = resolve(import.meta.dirname, "original-shell.html");

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

interface DomNode {
  nodeType: number;
  textContent: string | null;
  childNodes: Iterable<DomNode>;
  tagName?: string;
  attributes?: Iterable<{ name: string; value: string }>;
}

type NormalizedChild = { text: string } | NormalizedElement;

interface NormalizedElement {
  tag: string;
  // Attribute *sets*, not attribute order, are part of the contract: sorted
  // by name so source attribute order never affects the comparison.
  attrs: [string, string][];
  children: NormalizedChild[];
}

/**
 * Depth-first structural view of `node`'s children: element name + sorted
 * attributes + recursively-normalized children, trimmed non-empty text as
 * its own entry, comments and Solid's `_hk` hydration markers dropped.
 * Child order is preserved, since it is part of the DOM contract.
 */
function normalizeChildren(node: DomNode): NormalizedChild[] {
  const result: NormalizedChild[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType === COMMENT_NODE) {
      continue;
    }
    if (child.nodeType === TEXT_NODE) {
      const text = (child.textContent ?? "").trim();
      if (text) {
        result.push({ text });
      }
      continue;
    }
    if (child.nodeType === ELEMENT_NODE) {
      const attrs: [string, string][] = [];
      for (const attr of child.attributes ?? []) {
        if (attr.name === "_hk") {
          continue;
        }
        attrs.push([attr.name, attr.value]);
      }
      attrs.sort(([a], [b]) => a.localeCompare(b));
      result.push({
        tag: (child.tagName ?? "").toLowerCase(),
        attrs,
        children: normalizeChildren(child),
      });
    }
  }
  return result;
}

/** Parses `html` (a sibling-element fragment, not a full document) into DOM
 * nodes and normalizes them, using a fresh happy-dom window per parse so
 * this never touches the ambient `document` the test-runner's own
 * environment may provide. */
function normalizeFragment(html: string): NormalizedChild[] {
  const document = new Window().document;
  const container = document.createElement("div");
  container.innerHTML = html;
  return normalizeChildren(container as unknown as DomNode);
}

describe("Shell prerender fidelity", () => {
  let server: ViteDevServer;
  let rendered: string;

  beforeAll(async () => {
    // A middleware-mode-only Vite server, never listening on a port: just
    // enough to load shell.server.tsx through the real SSR-mode Solid JSX
    // compile, the same way apps/host/vite.config.ts's prerender plugin
    // does at build time.
    server = await createServer({
      configFile: false,
      root: UI_ROOT,
      logLevel: "warn",
      appType: "custom",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      plugins: [solid({ ssr: true })],
      resolve: { alias: { "@dotli/ui": resolve(UI_ROOT, "src") } },
    });
    const mod = await server.ssrLoadModule(
      resolve(UI_ROOT, "src/components/shell/shell.server.tsx"),
    );
    const renderShell = mod.renderShell as () => string;
    rendered = renderShell();
  });

  afterAll(async () => {
    await server.close();
  });

  it("As the prerendered shell, every element, attribute and text node of the original shell block survives, in order", () => {
    // Given
    const fixture = readFileSync(FIXTURE_PATH, "utf8");

    // When / Then
    expect(normalizeFragment(rendered)).toEqual(normalizeFragment(fixture));
  });
});
