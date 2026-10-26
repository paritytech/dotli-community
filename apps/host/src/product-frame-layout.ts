// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the product iframe's inline geometry. Every report recomputes and writes the whole
// box, so a product reload keeps the chat width and docks, and the chat width keeps the safe-area insets.

import { registerStoreStateReset } from '@dotli/shared';
import { productIframeBox } from './product-iframe-box.js';
import { getTopbarState } from './state/topbar.js';

export type TopbarLayout = {
  /** The frame keeps clear of the bar. Otherwise it takes the full height and the bar floats over it. */
  offset: boolean;
};

/** In px. */
export type DockInset = {
  right: number;
  bottom: number;
};

export type DockSource = 'debug' | 'sandbox-checker';

/** Where the frame sits, before it becomes inline style. */
export type FrameBox = {
  /** The frame starts below the bar. Otherwise it takes the full safe height. */
  belowBar: boolean;
  /** In px, reserved at the right edge by chat and the docks there. */
  right: number;
  /** In px, reserved at the bottom edge by the docks there. */
  bottom: number;
};

/** Writes a box onto the frame. */
export type ApplyFrameBox = (frame: HTMLIFrameElement, box: FrameBox) => void;

type LayoutState = {
  frame: HTMLIFrameElement | null;
  apply: ApplyFrameBox;
  topbarOffset: boolean;
  chatWidth: number;
  docks: Partial<Record<DockSource, DockInset>>;
};

function initialState(): LayoutState {
  return {
    frame: null,
    apply: applyFrameStyle,
    topbarOffset: true,
    chatWidth: 0,
    docks: {},
  };
}

let state = initialState();

/** The box for the reported layout. Docks at the same edge stack, so their insets add up. */
export function frameBox(layout: {
  topbarOffset: boolean;
  chatWidth: number;
  docks: Partial<Record<DockSource, DockInset>>;
}): FrameBox {
  let right = layout.chatWidth;
  let bottom = 0;
  for (const dock of Object.values(layout.docks)) {
    right += dock.right;
    bottom += dock.bottom;
  }
  return { belowBar: layout.topbarOffset, right, bottom };
}

/** The page's writer, keeping the box clear of the safe-area insets. */
function applyFrameStyle(frame: HTMLIFrameElement, box: FrameBox): void {
  const css = productIframeBox({ topbarOffset: box.belowBar });
  Object.assign(frame.style, {
    position: 'fixed',
    top: css.top,
    left: css.left,
    width: box.right === 0 ? css.width : `calc(${css.width} - ${String(box.right)}px)`,
    height: box.bottom === 0 ? css.height : `calc(${css.height} - ${String(box.bottom)}px)`,
    transform: '',
    transition: '',
    border: 'none',
    margin: '0',
    padding: '0',
  });
}

function write(): void {
  const { frame } = state;
  if (frame === null) {
    return;
  }
  // Floating, the frame never moves with the bar, so the product never relayouts on a hide or reveal.
  state.apply(
    frame,
    frameBox({
      topbarOffset: state.topbarOffset && getTopbarState().present,
      chatWidth: state.chatWidth,
      docks: state.docks,
    }),
  );
}

/** Layout reported before any frame existed applies to it now. */
export function attachProductFrame(iframe: HTMLIFrameElement, apply: ApplyFrameBox = applyFrameStyle): void {
  state.frame = iframe;
  state.apply = apply;
  write();
}

/** The frame attached last. During a reload the outgoing frame can still be in `#app`. */
export function currentProductFrame(): HTMLIFrameElement | null {
  const { frame } = state;
  return frame?.isConnected === true ? frame : null;
}

/** Where a dialog hands focus back when the element it came from is gone, for `ModalFocusFallback`. */
export function productFrameFocus(): HTMLIFrameElement | undefined {
  return currentProductFrame() ?? undefined;
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

registerStoreStateReset(() => {
  state = initialState();
});
