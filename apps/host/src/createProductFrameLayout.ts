// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the product iframe's inline geometry. Every report recomputes and writes the whole
// box, so a product reload keeps the chat width and docks, and the chat width keeps the safe-area insets.

import { registerStoreStateReset } from '@dotli/shared';
import { topbarState, type TopbarState } from './state/topbarState.js';

/** In px. */
type DockInset = {
  right: number;
  bottom: number;
};

type DockSource = 'debug' | 'sandbox-checker';

/** Where the frame sits, before it becomes inline style. */
export type FrameBox = {
  /** The frame starts below the bar. Otherwise it takes the full safe height. */
  belowBar: boolean;
  /** In px, reserved at the right edge by chat and the docks there. */
  right: number;
  /** In px, reserved at the bottom edge by the docks there. */
  bottom: number;
};

type TopbarLayout = {
  /** The frame keeps clear of the bar. Otherwise it takes the full height and the bar floats over it. */
  offset: boolean;
};

export type ProductFrameLayout = ReturnType<typeof createProductFrameLayout>;

type Params = {
  /** Writes a box onto the attached frame. Must not throw. */
  apply: (frame: HTMLIFrameElement, box: FrameBox) => void;
  /** Whether the page has the host's topbar, the page's own unless given. */
  topbar?: { get: () => Pick<TopbarState, 'present'> };
};

/** Builds a layout with no frame, below the bar, with no chat and no dock. Building it reads no browser global. */
export function createProductFrameLayout({ apply, topbar = topbarState }: Params) {
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
    // Docks at the same edge stack, so their insets add up.
    let right = chatWidth;
    let bottom = 0;
    for (const dock of Object.values(docks)) {
      right += dock.right;
      bottom += dock.bottom;
    }
    // Floating, the frame never moves with the bar, so the product never relayouts on a hide or reveal.
    apply(frame, { belowBar: topbarOffset && topbar.get().present, right, bottom });
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
    /** Makes `next` the product frame and writes onto it the layout reported so far, before any frame existed too. */
    attach,
    /**
     * Returns the frame attached last, or null once it left the page. During a reload the outgoing frame can still be
     * in `#app`.
     */
    getFrame,
    /** Returns where a dialog hands focus back when the element it came from is gone: the frame, else undefined. */
    getFocusFallback: (): HTMLIFrameElement | undefined => getFrame() ?? undefined,
    /** Records whether the frame keeps clear of the bar, and writes the box. */
    setTopbarLayout,
    /** Records the px chat covers at the right edge, 0 while the chat panel is closed, and writes the box. */
    setChatWidth,
    /** Records the inset the dock `source` takes, replacing its last one, and writes the box. */
    setDockInset,
  };
}

/** The page's layout, written as inline style on its product frame. */
export const productFrameLayout = createProductFrameLayout({ apply: applyFrameStyle });

/**
 * The page's writer, keeping the box clear of the safe-area insets and of what it reserves at its edges. The host
 * viewport covers the whole display, hence the insets. Values carry px fallbacks because they are inline styles that
 * can apply before the token stylesheet.
 */
function applyFrameStyle(frame: HTMLIFrameElement, { belowBar, right, bottom }: FrameBox): void {
  // The content edges already include the insets on the bar's side, so one term per edge covers both.
  const topEdge = belowBar ? 'var(--content-top, 68px)' : 'var(--safe-top, 0px)';
  const bottomEdge = belowBar ? 'var(--content-bottom, 0px)' : 'var(--safe-bottom, 0px)';
  const leftEdge = 'var(--safe-left, 0px)';
  Object.assign(frame.style, {
    position: 'fixed',
    top: topEdge,
    left: leftEdge,
    width: `calc(100% - ${leftEdge} - var(--safe-right, 0px) - ${String(right)}px)`,
    height: `calc(100dvh - ${topEdge} - ${bottomEdge} - ${String(bottom)}px)`,
    border: 'none',
    margin: '0',
    padding: '0',
  });
}
