// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the product iframe's inline geometry. Every report recomputes and writes the whole
// box, so a product reload keeps the chat width and docks, and the chat width keeps the safe-area insets.

import { registerStoreStateReset } from '@dotli/shared';
import { getFrameBox, type DockInset, type DockSource, type FrameBox } from './getFrameBox.js';
import { getProductIframeBox } from './getProductIframeBox.js';
import { topbarState } from './state/topbarState.js';

export type TopbarLayout = {
  /** The frame keeps clear of the bar. Otherwise it takes the full height and the bar floats over it. */
  offset: boolean;
};

export type ProductFrameLayout = ReturnType<typeof createProductFrameLayout>;

type Params = {
  /** Writes a box onto the attached frame. Must not throw. */
  apply: (frame: HTMLIFrameElement, box: FrameBox) => void;
};

/** Builds a layout with no frame, below the bar, with no chat and no dock. Building it reads no browser global. */
export function createProductFrameLayout({ apply }: Params) {
  let frame: HTMLIFrameElement | null = null;
  let topbarOffset = true;
  let chatWidth = 0;
  let docks: Partial<Record<DockSource, DockInset>> = {};

  registerStoreStateReset(() => {
    frame = null;
    topbarOffset = true;
    chatWidth = 0;
    docks = {};
  });

  function write(): void {
    if (frame === null) {
      return;
    }
    // Floating, the frame never moves with the bar, so the product never relayouts on a hide or reveal.
    apply(frame, getFrameBox({ topbarOffset: topbarOffset && topbarState.get().present, chatWidth, docks }));
  }

  function attach(next: HTMLIFrameElement): void {
    frame = next;
    write();
  }

  function getFrame(): HTMLIFrameElement | null {
    return frame?.isConnected === true ? frame : null;
  }

  function setTopbarLayout(layout: TopbarLayout): void {
    topbarOffset = layout.offset;
    write();
  }

  function setChatWidth(width: number): void {
    chatWidth = width;
    write();
  }

  function setDockInset(inset: DockInset, source: DockSource): void {
    docks = { ...docks, [source]: inset };
    write();
  }

  return {
    /**
     * Makes `next` the product frame and writes onto it the layout reported so far, before any frame existed too.
     * Never throws.
     */
    attach,
    /**
     * Returns the frame attached last, or null once it left the page. During a reload the outgoing frame can still be
     * in `#app`. Never throws.
     */
    getFrame,
    /**
     * Returns where a dialog hands focus back when the element it came from is gone: the frame, else undefined. Never
     * throws.
     */
    getFocusFallback: (): HTMLIFrameElement | undefined => getFrame() ?? undefined,
    /** Records whether the frame keeps clear of the bar, and writes the box. Never throws. */
    setTopbarLayout,
    /** Records the px chat covers at the right edge, 0 while the chat panel is closed, and writes the box. Never throws. */
    setChatWidth,
    /** Records the inset the dock `source` takes, replacing its last one, and writes the box. Never throws. */
    setDockInset,
  };
}

/** The page's layout, written as inline style on its product frame. */
export const productFrameLayout = createProductFrameLayout({ apply: applyFrameStyle });

/** The page's writer, keeping the box clear of the safe-area insets. */
function applyFrameStyle(frame: HTMLIFrameElement, box: FrameBox): void {
  const iframeBox = getProductIframeBox({ topbarOffset: box.belowBar });
  Object.assign(frame.style, {
    position: 'fixed',
    top: iframeBox.top,
    left: iframeBox.left,
    width: box.right === 0 ? iframeBox.width : `calc(${iframeBox.width} - ${String(box.right)}px)`,
    height: box.bottom === 0 ? iframeBox.height : `calc(${iframeBox.height} - ${String(box.bottom)}px)`,
    transform: '',
    transition: '',
    border: 'none',
    margin: '0',
    padding: '0',
  });
}
