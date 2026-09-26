// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host shell markup is a frozen contract (imperative code in
// packages/ui/src/topbar.ts, and Playwright selectors, select these ids and
// classes verbatim). This test proves that prerendering <Shell/> reproduces
// tests/components/shell/original-shell.html - the exact block that used to
// live in apps/host/index.html before it was replaced by the `#shell`
// placeholder - node for node: same elements, same attributes, same text,
// same order. Solid's hydration markers (`_hk=...`) and HTML comments are
// not part of that contract, so both are stripped before comparing.
//
// The rendered side is the real SSR output (see helpers/shell-ssr.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { beforeAll, describe, expect, it } from "vitest";
import { renderShellOnServer } from "../../helpers/shell-ssr";

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
  let rendered: string;

  beforeAll(async () => {
    rendered = await renderShellOnServer();
  });

  it("As the prerendered shell, every element, attribute and text node of the original shell block survives, in order", () => {
    // Given
    const fixture = readFileSync(FIXTURE_PATH, "utf8");

    // When / Then
    expect(normalizeFragment(rendered)).toEqual(normalizeFragment(fixture));
  });
});
