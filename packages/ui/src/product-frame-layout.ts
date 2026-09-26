// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one writer of the product iframe's inline geometry.
 *
 * Three parties shape the frame: the bridge places each newly rendered frame,
 * the topbar auto-hide moves it with the bar, and the chat panel narrows it.
 * They each report their part here, and every change recomputes the whole box
 * from `productIframeBox()` and writes all of it, so a product reload keeps the
 * chat width and the chat width keeps the safe-area insets.
 */

import { productIframeBox } from "./product-iframe-box";

const TOPBAR_HEIGHT = "var(--topbar-height, 56px)";
const SAFE_TOP = "var(--safe-top, 0px)";

export interface TopbarLayout {
  /** The frame's layout box starts below the bar, with no transform. */
  offset: boolean;
  /** With `offset` off, whether the bar is on screen, so the frame shifts. */
  shown: boolean;
  /** The frame's transition while it tracks the bar ("none" for reduced motion). */
  transition: string;
}

interface LayoutState {
  frame: HTMLIFrameElement | null;
  topbarOffset: boolean;
  topbarShown: boolean;
  transition: string;
  chatWidth: number;
}

function initialState(): LayoutState {
  return {
    frame: null,
    topbarOffset: true,
    topbarShown: true,
    transition: "",
    chatWidth: 0,
  };
}

let state = initialState();

function write(): void {
  const { frame } = state;
  if (frame === null) {
    return;
  }
  let box;
  let transform = "";
  let transition = "";
  if (!state.topbarOffset) {
    // Tracking the auto-hiding bar: the box keeps its hidden-bar size and a
    // transform follows the bar, so the product document never relayouts.
    box = productIframeBox({ topbarOffset: false });
    transition = state.transition;
    // --topbar-height already includes the top inset, so shift by the rest.
    transform = state.topbarShown
      ? `translateY(calc(${TOPBAR_HEIGHT} - ${SAFE_TOP}))`
      : "translateY(0)";
  } else {
    // A page without the bar has nothing to clear but the top inset.
    box = productIframeBox({
      topbarOffset: document.getElementById("topbar") !== null,
    });
  }
  const width =
    state.chatWidth === 0
      ? box.width
      : `calc(${box.width} - ${String(state.chatWidth)}px)`;
  Object.assign(frame.style, {
    position: "fixed",
    top: box.top,
    left: box.left,
    width,
    height: box.height,
    transform,
    transition,
    border: "none",
    margin: "0",
    padding: "0",
  });
}

/**
 * Take over a newly rendered product frame. The latest frame wins, and layout
 * reported before any frame existed applies to it now.
 */
export function attachProductFrame(iframe: HTMLIFrameElement): void {
  state.frame = iframe;
  write();
}

/** Report where the bar is, from the topbar auto-hide. */
export function setTopbarLayout(layout: TopbarLayout): void {
  state.topbarOffset = layout.offset;
  state.topbarShown = layout.shown;
  state.transition = layout.transition;
  write();
}

/** Report the docked chat panel's width in px, 0 while it is closed. */
export function setChatWidth(px: number): void {
  state.chatWidth = px;
  write();
}

/** Forget the frame and the reported layout. Tests only. */
export function resetProductFrameLayout(): void {
  state = initialState();
}
