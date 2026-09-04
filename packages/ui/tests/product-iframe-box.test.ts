// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { productIframeBox } from "@dotli/ui/product-iframe-box";

/**
 * These assert the declared style, not the resolved pixels.
 *
 * happy-dom's CSS parser discards any declaration whose value is a `var()` or a
 * `calc()`, so reading the values back off an element yields empty strings. The
 * box is built as plain data for that reason, which keeps the contract that the
 * host reserves each inset checkable without a browser.
 */

describe("product iframe box", () => {
  it("As a user on a notched phone, the product sits below the topbar and clear of every display inset", () => {
    // Given
    const opts = { topbarOffset: true };

    // When
    const box = productIframeBox(opts);

    // Then
    expect(box.top).toBe("var(--topbar-height, 56px)");
    expect(box.left).toBe("var(--safe-left, 0px)");
    expect(box.width).toBe(
      "calc(100% - var(--safe-left, 0px) - var(--safe-right, 0px))",
    );
    expect(box.height).toBe(
      "calc(100dvh - var(--topbar-height, 56px) - var(--safe-bottom, 0px))",
    );
  });

  it("As a user on a notched phone with the topbar hidden, the product still starts below the status bar", () => {
    // Given
    const opts = { topbarOffset: false };

    // When
    const box = productIframeBox(opts);

    // Then
    expect(box.top).toBe("var(--safe-top, 0px)");
    expect(box.height).toBe(
      "calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px))",
    );
  });

  it("As a user on a notched phone, the product never covers the home indicator in either topbar state", () => {
    // Given
    const states = [true, false];

    // When
    const heights = states.map(
      (topbarOffset) => productIframeBox({ topbarOffset }).height,
    );

    // Then
    for (const height of heights) {
      expect(height).toContain("var(--safe-bottom, 0px)");
    }
  });

  it("As a user on a browser without env() support, every reserved inset falls back to zero", () => {
    // Given
    const box = productIframeBox({ topbarOffset: true });
    const values = [box.top, box.left, box.width, box.height];

    // When
    const tokens = values.flatMap(
      (value) => value.match(/var\(--[a-z-]+, [^)]+\)/g) ?? [],
    );

    // Then
    // Without a fallback the whole declaration drops and the layout breaks, so
    // each token must name one. The topbar keeps its own 56px default.
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token).toMatch(/, (0px|56px)\)$/);
    }
  });
});
