// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachProductFrame,
  resetProductFrameLayout,
  setChatWidth,
  setTopbarLayout,
} from "@dotli/ui/product-frame-layout";

/**
 * These assert the declared style, not the resolved pixels.
 *
 * happy-dom's CSS parser discards a `calc()` that holds a `var()`, so a real
 * iframe would read back empty strings for the inset-aware values. The frame
 * here is a stand-in whose style records each declaration as written.
 */
type RecordedStyle = Record<string, string>;

function recordingFrame(): {
  frame: HTMLIFrameElement;
  style: RecordedStyle;
} {
  const style: RecordedStyle = {};
  return { frame: { style } as unknown as HTMLIFrameElement, style };
}

const SAFE_WIDTH =
  "calc(100% - var(--safe-left, 0px) - var(--safe-right, 0px))";
const BELOW_BAR_TOP = "var(--topbar-height, 56px)";
const BELOW_BAR_HEIGHT =
  "calc(100dvh - var(--topbar-height, 56px) - var(--safe-bottom, 0px))";
const HIDDEN_BAR_TOP = "var(--safe-top, 0px)";
const HIDDEN_BAR_HEIGHT =
  "calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px))";
const SHIFT_BELOW_BAR =
  "translateY(calc(var(--topbar-height, 56px) - var(--safe-top, 0px)))";
const SLIDE = "transform 0.3s ease";

beforeEach(() => {
  document.body.innerHTML = `<div id="topbar"></div>`;
});

afterEach(() => {
  resetProductFrameLayout();
});

describe("product frame layout", () => {
  it("As a dApp user, a new product frame sits below the bar, clear of every inset", () => {
    // Given
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style).toEqual({
      position: "fixed",
      top: BELOW_BAR_TOP,
      left: "var(--safe-left, 0px)",
      width: SAFE_WIDTH,
      height: BELOW_BAR_HEIGHT,
      transform: "",
      transition: "",
      border: "none",
      margin: "0",
      padding: "0",
    });
  });

  it("As a dApp user, hiding and revealing the bar moves the frame by transform only", () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When the bar hides
    setTopbarLayout({ offset: false, shown: false, transition: SLIDE });

    // Then
    expect(style.top).toBe(HIDDEN_BAR_TOP);
    expect(style.height).toBe(HIDDEN_BAR_HEIGHT);
    expect(style.transform).toBe("translateY(0)");
    expect(style.transition).toBe(SLIDE);

    // When the bar comes back
    setTopbarLayout({ offset: false, shown: true, transition: SLIDE });

    // Then the layout box stays, and the transform shifts the frame down
    expect(style.top).toBe(HIDDEN_BAR_TOP);
    expect(style.height).toBe(HIDDEN_BAR_HEIGHT);
    expect(style.transform).toBe(SHIFT_BELOW_BAR);

    // When the bar is pinned again
    setTopbarLayout({ offset: true, shown: true, transition: "" });

    // Then
    expect(style.top).toBe(BELOW_BAR_TOP);
    expect(style.height).toBe(BELOW_BAR_HEIGHT);
    expect(style.transform).toBe("");
    expect(style.transition).toBe("");
  });

  it("As a reduced-motion user, the frame follows the bar without a slide", () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setTopbarLayout({ offset: false, shown: false, transition: "none" });

    // Then
    expect(style.transition).toBe("none");
  });

  it("As a chat user, opening, resizing and closing chat narrows and restores the frame", () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setChatWidth(360);

    // Then
    expect(style.width).toBe(`calc(${SAFE_WIDTH} - 360px)`);

    // When
    setChatWidth(420);

    // Then
    expect(style.width).toBe(`calc(${SAFE_WIDTH} - 420px)`);

    // When
    setChatWidth(0);

    // Then
    expect(style.width).toBe(SAFE_WIDTH);
  });

  it("As a chat user on a notched phone, the chat-narrowed frame still keeps clear of the side insets", () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setChatWidth(360);

    // Then
    expect(style.width).toContain("var(--safe-left, 0px)");
    expect(style.width).toContain("var(--safe-right, 0px)");
    expect(style.left).toBe("var(--safe-left, 0px)");
  });

  it("As a chat user, a product reload keeps the chat-narrowed width", () => {
    // Given
    const first = recordingFrame();
    attachProductFrame(first.frame);
    setChatWidth(360);
    setTopbarLayout({ offset: false, shown: false, transition: SLIDE });

    // When the product re-renders into a new frame
    const second = recordingFrame();
    attachProductFrame(second.frame);

    // Then the new frame gets the whole layout
    expect(second.style.width).toBe(`calc(${SAFE_WIDTH} - 360px)`);
    expect(second.style.top).toBe(HIDDEN_BAR_TOP);
    expect(second.style.transform).toBe("translateY(0)");

    // And later writes go to the latest frame only
    setChatWidth(0);
    expect(second.style.width).toBe(SAFE_WIDTH);
    expect(first.style.width).toBe(`calc(${SAFE_WIDTH} - 360px)`);
  });

  it("As a dotli integrator, layout set before any product frame applies once one attaches", () => {
    // Given
    setChatWidth(360);
    setTopbarLayout({ offset: false, shown: true, transition: SLIDE });
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style.width).toBe(`calc(${SAFE_WIDTH} - 360px)`);
    expect(style.top).toBe(HIDDEN_BAR_TOP);
    expect(style.transform).toBe(SHIFT_BELOW_BAR);
    expect(style.transition).toBe(SLIDE);
  });

  it("As a dotli integrator, a page without a bar gives the frame the full safe height", () => {
    // Given
    document.body.innerHTML = "";
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style.top).toBe(HIDDEN_BAR_TOP);
    expect(style.height).toBe(HIDDEN_BAR_HEIGHT);
    expect(style.transform).toBe("");
  });
});
