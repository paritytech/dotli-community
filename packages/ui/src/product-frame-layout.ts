// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one writer of the product iframe's inline geometry.
 *
 * Several parties shape the frame: the bridge places each newly rendered frame,
 * the topbar auto-hide moves it with the bar, the chat panel narrows it, and
 * the TrUAPI debug dock and the sandbox checker reserve an edge for their
 * panels. They each report their part here, and every change recomputes the
 * whole box from `productIframeBox()` and writes all of it, so a product reload
 * keeps the chat width and the docks, and the chat width keeps the safe-area
 * insets.
 */

import { productIframeBox } from './product-iframe-box.js';
import { getTopbarState } from './state/topbar.js';

const TOPBAR_HEIGHT = 'var(--topbar-height, 56px)';
const SAFE_TOP = 'var(--safe-top, 0px)';

export interface TopbarLayout {
  /** The frame's layout box starts below the bar, with no transform. */
  offset: boolean;
  /** With `offset` off, whether the bar is on screen, so the frame shifts. */
  shown: boolean;
  /** The frame's transition while it tracks the bar ("none" for reduced motion). */
  transition: string;
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
  /** The element whose geometry is written: the frame, or its Media compositor. */
  box: HTMLElement | null;
  topbarOffset: boolean;
  topbarShown: boolean;
  transition: string;
  chatWidth: number;
  docks: Partial<Record<DockSource, DockInset>>;
}

function initialState(): LayoutState {
  return {
    frame: null,
    box: null,
    topbarOffset: true,
    topbarShown: true,
    transition: '',
    chatWidth: 0,
    docks: {},
  };
}

let state = initialState();

function write(): void {
  const { box: target } = state;
  if (target === null) {
    return;
  }
  let box;
  let transform = '';
  let transition = '';
  if (!state.topbarOffset) {
    // Tracking the auto-hiding bar: the box keeps its hidden-bar size and a
    // transform follows the bar, so the product document never relayouts.
    // While the bar is shown and the frame is slid down, a bottom dock covers
    // the same strip auto-hide already gives up; that is deliberate, since the
    // height stays fixed so the product never re-lays out on bar moves.
    box = productIframeBox({ topbarOffset: false });
    transition = state.transition;
    // --topbar-height already includes the top inset, so shift by the rest.
    transform = state.topbarShown ? `translateY(calc(${TOPBAR_HEIGHT} - ${SAFE_TOP}))` : 'translateY(0)';
  } else {
    // A page without the bar has nothing to clear but the top inset.
    box = productIframeBox({
      topbarOffset: getTopbarState().present,
    });
  }
  // Docks at the same edge stack, so their insets add up.
  let right = state.chatWidth;
  let bottom = 0;
  for (const dock of Object.values(state.docks)) {
    right += dock.right;
    bottom += dock.bottom;
  }
  Object.assign(target.style, {
    position: 'fixed',
    top: box.top,
    left: box.left,
    width: right === 0 ? box.width : `calc(${box.width} - ${String(right)}px)`,
    height: bottom === 0 ? box.height : `calc(${box.height} - ${String(bottom)}px)`,
    transform,
    transition,
    border: 'none',
    margin: '0',
    padding: '0',
  });
}

/**
 * Take over a newly rendered product frame. The latest frame wins, and layout
 * reported before any frame existed applies to it now. A protected Media
 * container passes its compositor as `box`: the compositor takes the geometry
 * and the frame fills it.
 */
export function attachProductFrame(iframe: HTMLIFrameElement, box: HTMLElement = iframe): void {
  state.frame = iframe;
  state.box = box;
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

/** Report the space `source`'s docked panel covers, all 0 once it is gone. */
export function setDockInset(inset: DockInset, source: DockSource): void {
  state.docks[source] = inset;
  write();
}

/** Forget the frame and the reported layout. Tests only. */
export function resetProductFrameLayout(): void {
  state = initialState();
}
