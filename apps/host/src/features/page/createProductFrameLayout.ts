// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the product iframe's inline geometry. Every report recomputes and writes the whole
// box, so a product reload keeps the docks, and the docks keep the safe-area insets.

import { listen, registerStoreStateReset } from '@dotli/shared';
import { isPhoneViewport, watchPhoneViewport } from '@dotli/ui';
import { topbarState, type TopbarState } from './topbarState.js';

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
  /** The frame is a card beside a docked side panel, below the band the stage opens. */
  staged: boolean;
  /** The box animates its changes, as it does while staged and through the morph back out of the stage. */
  morph: boolean;
  /** In px, reserved at the right edge by the docks there. */
  right: number;
  /** In px, reserved at the bottom edge by the docks there. */
  bottom: number;
};

type TopbarLayout = {
  /** The frame keeps clear of the bar. Otherwise it takes the full height and the bar floats over it. */
  offset: boolean;
};

type SidePanel = {
  /** A side panel is open beside the frame, rather than over it. */
  docked: boolean;
};

type Panel = { kind: 'undocked' } | { kind: 'docked'; unwatchPhone: () => void };

type Stage = { kind: 'off' } | { kind: 'staged' } | { kind: 'leaving'; stopListening: () => void };

const CONTENT_TOP = 'var(--content-top, 68px)';

export type ProductFrameLayout = ReturnType<typeof createProductFrameLayout>;

type Params = {
  /** Writes a box onto the attached frame. Must not throw. */
  apply: (frame: HTMLIFrameElement, box: FrameBox) => void;
  /** Marks the page as staged or not. Must not throw. The page's own unless given. */
  applyStage?: (staged: boolean) => void;
  /** Whether the page has the host's topbar, the page's own unless given. */
  topbar?: { get: () => Pick<TopbarState, 'present'> };
  /** A phone is never staged. The page's own unless given. */
  isPhone?: () => boolean;
  /** Returns the unwatch. The page's own unless given. */
  watchPhone?: (onChange: () => void) => () => void;
};

/** Builds a layout with no frame, below the bar, with no dock and no stage. Building it reads no browser global. */
export function createProductFrameLayout({
  apply,
  applyStage = applyPageStage,
  topbar = topbarState,
  isPhone = isPhoneViewport,
  watchPhone = watchPhoneViewport,
}: Params) {
  let frame: HTMLIFrameElement | null = null;
  let topbarOffset = true;
  let docks: Partial<Record<DockSource, DockInset>> = {};
  let panel: Panel = { kind: 'undocked' };
  let stage: Stage = { kind: 'off' };

  registerStoreStateReset(() => {
    if (panel.kind === 'docked') {
      panel.unwatchPhone();
    }
    if (stage.kind === 'leaving') {
      stage.stopListening();
    }
    frame = null;
    topbarOffset = true;
    docks = {};
    panel = { kind: 'undocked' };
    stage = { kind: 'off' };
  });

  function write(): void {
    if (frame === null) {
      return;
    }
    // Docks at the same edge stack, so their insets add up.
    let right = 0;
    let bottom = 0;
    for (const dock of Object.values(docks)) {
      right += dock.right;
      bottom += dock.bottom;
    }
    apply(frame, {
      // Floating, the frame never moves with the bar, so the product never relayouts on a hide or reveal.
      belowBar: topbarOffset && topbar.get().present,
      staged: stage.kind === 'staged',
      morph: stage.kind !== 'off',
      right,
      bottom,
    });
  }

  function attach(next: HTMLIFrameElement): void {
    // A frame attached while the last one morphs back was never a card, so it has no morph to run.
    if (stage.kind === 'leaving') {
      stage.stopListening();
      stage = { kind: 'off' };
    }
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

  function setDockInset(inset: DockInset, source: DockSource): void {
    docks = { ...docks, [source]: inset };
    write();
  }

  function setSidePanel({ docked }: SidePanel): void {
    if (docked === (panel.kind === 'docked')) {
      return;
    }
    if (panel.kind === 'docked') {
      panel.unwatchPhone();
      panel = { kind: 'undocked' };
    } else {
      // Only a docked panel stages the page, so only then does the viewport matter.
      panel = { kind: 'docked', unwatchPhone: watchPhone(restage) };
    }
    restage();
  }

  function restage(): void {
    const staged = panel.kind === 'docked' && !isPhone();
    if (staged === (stage.kind === 'staged')) {
      return;
    }
    if (stage.kind === 'leaving') {
      stage.stopListening();
    }
    const attached = getFrame();
    if (staged) {
      stage = { kind: 'staged' };
    } else if (attached === null) {
      stage = { kind: 'off' };
    } else {
      stage = leave(attached);
    }
    applyStage(staged);
    write();
  }

  /** Keeps the box animating until the frame's morph out of the stage ends, so a later change lands at once. */
  function leave(morphing: HTMLIFrameElement): Stage {
    // Every property of the morph runs as long, so the first to end ends it.
    const stopListening = listen({
      target: morphing,
      type: 'transitionend',
      handler() {
        stopListening();
        stage = { kind: 'off' };
        write();
      },
    });
    return { kind: 'leaving', stopListening };
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
    /** Records the inset the dock `source` takes, replacing its last one, and writes the box. */
    setDockInset,
    /**
     * Records whether a side panel is docked open, which stages the page on a viewport wider than a phone, and writes
     * the box when the stage changes. Idempotent: repeating the current answer does nothing.
     */
    setSidePanel,
  };
}

/** The page's layout, written as inline style on its product frame. */
export const productFrameLayout = createProductFrameLayout({ apply: applyFrameStyle });

/**
 * The page's writer, keeping the box clear of the safe-area insets and of what it reserves at its edges. The host
 * viewport covers the whole display, hence the insets. Values carry px fallbacks because they are inline styles that
 * can apply before the token stylesheet. The morph itself is left to a stylesheet, so it follows the reduced-motion
 * setting.
 */
function applyFrameStyle(frame: HTMLIFrameElement, box: FrameBox): void {
  const edges = getFrameEdges(box);
  Object.assign(frame.style, {
    position: 'fixed',
    top: edges.top,
    left: edges.left,
    width: `calc(100% - ${edges.left} - ${edges.right} - ${String(box.right)}px)`,
    height: `calc(100dvh - ${edges.top} - ${edges.bottom} - ${String(box.bottom)}px)`,
    borderRadius: box.staged ? 'var(--r-pop, 20px)' : '',
    border: 'none',
    margin: '0',
    padding: '0',
  });
  frame.toggleAttribute('data-morph', box.morph);
}

/** Returns how far each edge of the frame sits from the window's, before the docks take their room. */
function getFrameEdges({ belowBar, staged }: FrameBox): Record<'top' | 'right' | 'bottom' | 'left', string> {
  if (staged) {
    // A card with the side panel's inset from the content edges, which leaves the panel's room and a gap at the right.
    const inset = 'var(--sp-2, 8px)';
    return {
      top: `calc(${CONTENT_TOP} + ${inset})`,
      right: `calc(var(--safe-right, 0px) + ${inset} + var(--w-pop-lg, 360px) + ${inset})`,
      bottom: `calc(var(--content-bottom, 0px) + ${inset})`,
      left: `calc(var(--safe-left, 0px) + ${inset})`,
    };
  }
  // The content edges already include the insets on the bar's side, so one term per edge covers both.
  return {
    top: belowBar ? CONTENT_TOP : 'var(--safe-top, 0px)',
    right: 'var(--safe-right, 0px)',
    bottom: belowBar ? 'var(--content-bottom, 0px)' : 'var(--safe-bottom, 0px)',
    left: 'var(--safe-left, 0px)',
  };
}

/** Marks the root element, so a stylesheet can redefine the custom properties declared on `:root` while staged. */
function applyPageStage(staged: boolean): void {
  document.documentElement.toggleAttribute('data-staged', staged);
}
