// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the product iframe's inline geometry. Every report recomputes and writes the whole
// box, so a product reload keeps the chat width and docks, and the chat width keeps the safe-area insets.

import { productIframeBox } from './product-iframe-box.js';
import { getTopbarState } from './state/topbar.js';

export interface TopbarLayout {
  /** The frame keeps clear of the bar. Otherwise it takes the full height and the bar floats over it. */
  offset: boolean;
}

/** In px. */
export interface DockInset {
  right: number;
  bottom: number;
}

export type DockSource = 'debug' | 'sandbox-checker';

interface LayoutState {
  frame: HTMLIFrameElement | null;
  /** The element whose geometry is written: the frame, or its Media compositor. */
  box: HTMLElement | null;
  topbarOffset: boolean;
  chatWidth: number;
  docks: Partial<Record<DockSource, DockInset>>;
}

function initialState(): LayoutState {
  return {
    frame: null,
    box: null,
    topbarOffset: true,
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
  // Floating, the frame never moves with the bar, so the product never relayouts on a hide or reveal.
  const box = productIframeBox({ topbarOffset: state.topbarOffset && getTopbarState().present });
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
    transform: '',
    transition: '',
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

/** The frame attached last. During a reload the outgoing frame can still be in `#app`. */
export function currentProductFrame(): HTMLIFrameElement | null {
  const { frame } = state;
  return frame?.isConnected === true ? frame : null;
}

export function setTopbarLayout(layout: TopbarLayout): void {
  state.topbarOffset = layout.offset;
  write();
}

/** 0 while the chat panel is closed. */
export function setChatWidth(px: number): void {
  state.chatWidth = px;
  write();
}

export function setDockInset(inset: DockInset, source: DockSource): void {
  state.docks[source] = inset;
  write();
}

/** Tests only. */
export function resetProductFrameLayout(): void {
  state = initialState();
}
