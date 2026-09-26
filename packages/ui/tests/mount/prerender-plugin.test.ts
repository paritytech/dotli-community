// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { injectPrerendered } from "@dotli/ui/mount/prerender-plugin";

const PLACEHOLDER = "<!--ssr:shell-->";

describe("injectPrerendered", () => {
  it("As the build output, the placeholder is replaced by the rendered HTML verbatim", () => {
    // Given
    const html = `<body><div id="shell">${PLACEHOLDER}</div><div id="app"></div></body>`;
    const rendered = `<span data-hk="shell0">a $& b $1</span>`;

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
