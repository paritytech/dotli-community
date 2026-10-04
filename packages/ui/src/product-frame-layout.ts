// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one writer of the product iframe's inline geometry.
 *
 * Several parties shape the frame: the bridge places each newly rendered frame,
 * the topbar says whether the frame starts below it, the chat panel narrows it, and
 * the TrUAPI debug dock and the sandbox checker reserve an edge for their
 * panels. They each report their part here, and every change recomputes the
 * whole box from `productIframeBox()` and writes all of it, so a product reload
 * keeps the chat width and the docks, and the chat width keeps the safe-area
 * insets.
 */

import { productIframeBox } from './product-iframe-box.js';
import { getTopbarState } from './state/topbar.js';

export interface TopbarLayout {
  /**
   * The frame starts below the bar (the phone header). Otherwise it takes
   * the full height and the bar floats over it, as the pill and the capsule
   * do.
   */
  offset: boolean;
}

/** Space a docked panel covers along the frame's edges, in px (0 for none). */
export interface DockInset {
  right: number;
  bottom: number;
}

/** The panels that can dock over the frame, at the same time. */
export type DockSource = 'debug' | 'sandbox-checker';

interface LayoutState {
  frame: HTMLIFrameElement | null;
  topbarOffset: boolean;
  chatWidth: number;
  docks: Partial<Record<DockSource, DockInset>>;
}

function initialState(): LayoutState {
  return {
    frame: null,
    topbarOffset: true,
    chatWidth: 0,
    docks: {},
  };
}

let state = initialState();

function write(): void {
  const { frame } = state;
  if (frame === null) {
    return;
  }
  // Floating (offset off), the frame never moves with the bar, so the
  // product document never relayouts on a hide or a reveal.
  const box = productIframeBox({ topbarOffset: state.topbarOffset && getTopbarState().present });
  // Docks at the same edge stack, so their insets add up.
  let right = state.chatWidth;
  let bottom = 0;
  for (const dock of Object.values(state.docks)) {
    right += dock.right;
    bottom += dock.bottom;
  }
  Object.assign(frame.style, {
    position: 'fixed',
    top: box.top,
    left: box.left,
    width: right === 0 ? box.width : `calc(${box.width} - ${String(right)}px)`,
    height: bottom === 0 ? box.height : `calc(${box.height} - ${String(bottom)}px)`,
    transform: '',
    transition: '',
    border: 'none',
    margin: '0',
    padding: '0',
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

/**
 * The product frame on screen: the one attached last, while it is still in
 * the page. During a reload the outgoing frame can stay in `#app` while the
 * new one boots; this is always the new one.
 */
export function currentProductFrame(): HTMLIFrameElement | null {
  const { frame } = state;
  return frame?.isConnected === true ? frame : null;
}

/** Report whether the frame starts below the bar, from the topbar auto-hide. */
export function setTopbarLayout(layout: TopbarLayout): void {
  state.topbarOffset = layout.offset;
  write();
}

/** Report the docked chat panel's width in px, 0 while it is closed. */
export function setChatWidth(px: number): void {
  state.chatWidth = px;
  write();
}

/** Report the space `source`'s docked panel covers, all 0 once it is gone. */
export function setDockInset(inset: DockInset, source: DockSource): void {
  state.docks[source] = inset;
  write();
}

/** Forget the frame and the reported layout. Tests only. */
export function resetProductFrameLayout(): void {
  state = initialState();
}
