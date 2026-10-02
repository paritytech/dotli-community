// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drag handles of the TrUAPI debug panel: the edge that resizes the panel and
// the splitter between the views and the detail pane.
//
// Both write inline styles on the panel element directly, as the drag moves:
// sizes are custom properties and inline width/height the CSS grid picks up
// without a render, and docking clears them imperatively too. A move only
// writes: nothing on the move path reads layout, so a drag never forces a
// synchronous reflow, and the product frame is refitted once per frame.

import { onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from '@dotli/truapi-debug';
import { startDrag } from '../drag.js';

/** Events list / top pane: filter chips and tabs need room. */
const MIN_PRIMARY_PX = 220;
/** Detail / bottom pane: room for the key-value list. */
const MIN_SECONDARY_PX = 260;
/** Matches the grid-template-{columns,rows} middle track. */
const SPLITTER_PX = 6;
const MIN_BOTTOM_HEIGHT_PX = 120;
const MIN_RIGHT_WIDTH_PX = 280;
const MAX_VIEWPORT_SHARE = 0.8;

/** Top edge (bottom dock) or left edge (right dock) of the panel. */
export function ResizeHandle(props: {
  panel: () => HTMLElement | undefined;
  collapsed: boolean;
  dock: DockPosition;
  /** The panel's new size in px along the drag (height when docked at the
   *  bottom, width when docked right). At most once per animation frame. */
  onResize: (px: number) => void;
}): JSX.Element {
  const panelEl = untrack(() => props.panel);
  let handle: HTMLDivElement | undefined;
  let stopDrag: (() => void) | undefined;
  let resized: number | null = null;
  let frame: number | null = null;
  onCleanup(() => {
    stopDrag?.();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  });

  const move = (e: PointerEvent): void => {
    const panel = panelEl();
    if (panel === undefined) {
      return;
    }
    let clamped: number;
    if (props.dock === 'right') {
      const newWidth = window.innerWidth - e.clientX;
      clamped = Math.max(MIN_RIGHT_WIDTH_PX, Math.min(newWidth, window.innerWidth * MAX_VIEWPORT_SHARE));
      panel.style.width = `${String(clamped)}px`;
    } else {
      const newHeight = window.innerHeight - e.clientY;
      clamped = Math.max(MIN_BOTTOM_HEIGHT_PX, Math.min(newHeight, window.innerHeight * MAX_VIEWPORT_SHARE));
      panel.style.height = `${String(clamped)}px`;
    }
    // The size is already known: hand it over rather than read it back.
    resized = clamped;
    frame ??= requestAnimationFrame(() => {
      frame = null;
      if (resized !== null) {
        props.onResize(resized);
        resized = null;
      }
    });
  };

  return (
    <div
      class="td-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      ref={el => {
        handle = el;
      }}
      onPointerDown={e => {
        if (!props.collapsed && handle !== undefined) {
          stopDrag = startDrag(handle, e, { move });
        }
      }}
    />
  );
}

/**
 * Drag-to-resize divider between the views pane (list / timeline) and the
 * event-detail pane. The primary pane's size lives in a CSS custom property
 * on the panel element. Clamped to keep either side from collapsing so far
 * that its controls become unusable. Double-click restores the default.
 */
export function BodySplitter(props: { panel: () => HTMLElement | undefined; stacked: boolean }): JSX.Element {
  const panelEl = untrack(() => props.panel);
  let splitter: HTMLDivElement | undefined;
  let stopDrag: (() => void) | undefined;
  onCleanup(() => {
    stopDrag?.();
  });

  /** `body` is the body's box, measured once when the drag starts: it does
   *  not change size while the splitter moves, and measuring on every move
   *  would read layout right after the previous move's write. */
  const move = (e: PointerEvent, body: DOMRect): void => {
    const panel = panelEl();
    if (panel === undefined) {
      return;
    }
    if (props.stacked) {
      const relY = e.clientY - body.top;
      const maxTop = Math.max(MIN_PRIMARY_PX, body.height - MIN_SECONDARY_PX - SPLITTER_PX);
      const clamped = Math.max(MIN_PRIMARY_PX, Math.min(relY, maxTop));
      panel.style.setProperty('--td-top-height', `${String(clamped)}px`);
    } else {
      const relX = e.clientX - body.left;
      const maxLeft = Math.max(MIN_PRIMARY_PX, body.width - MIN_SECONDARY_PX - SPLITTER_PX);
      const clamped = Math.max(MIN_PRIMARY_PX, Math.min(relX, maxLeft));
      panel.style.setProperty('--td-left-width', `${String(clamped)}px`);
    }
  };

  return (
    <div
      class="td-body-splitter"
      role="separator"
      aria-orientation={props.stacked ? 'horizontal' : 'vertical'}
      tabindex="-1"
      title="Drag to resize"
      ref={el => {
        splitter = el;
      }}
      onPointerDown={e => {
        const el = splitter;
        const body = el?.parentElement?.getBoundingClientRect();
        if (el === undefined || body === undefined) {
          return;
        }
        el.classList.add('dragging');
        stopDrag = startDrag(el, e, {
          move: m => {
            move(m, body);
          },
          end: () => {
            el.classList.remove('dragging');
          },
        });
      }}
      onDblClick={() => {
        const panel = panelEl();
        panel?.style.removeProperty('--td-left-width');
        panel?.style.removeProperty('--td-top-height');
      }}
    />
  );
}
