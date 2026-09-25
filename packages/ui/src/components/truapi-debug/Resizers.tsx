// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drag handles of the TrUAPI debug panel: the edge that resizes the panel and
// the splitter between the views and the detail pane.
//
// Both write inline styles on the panel element directly, as the drag moves:
// sizes are custom properties and inline width/height the CSS grid picks up
// without a render, and docking clears them imperatively too.

import { onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DockPosition } from "@dotli/truapi-debug/dock-storage";

/** Events list / top pane: filter chips and tabs need room. */
const MIN_PRIMARY_PX = 220;
/** Detail / bottom pane: room for the key-value list. */
const MIN_SECONDARY_PX = 260;
/** Matches the grid-template-{columns,rows} middle track. */
const SPLITTER_PX = 6;
const MIN_BOTTOM_HEIGHT_PX = 120;
const MIN_RIGHT_WIDTH_PX = 280;
const MAX_VIEWPORT_SHARE = 0.8;

/** Window-level drag tracking, removed with the component. */
function trackDrag(handlers: {
  move: (e: PointerEvent) => void;
  up: () => void;
}): void {
  window.addEventListener("pointermove", handlers.move);
  window.addEventListener("pointerup", handlers.up);
  onCleanup(() => {
    window.removeEventListener("pointermove", handlers.move);
    window.removeEventListener("pointerup", handlers.up);
  });
}

/** Top edge (bottom dock) or left edge (right dock) of the panel. */
export function ResizeHandle(props: {
  panel: () => HTMLElement | undefined;
  collapsed: boolean;
  dock: DockPosition;
  onResize: () => void;
}): JSX.Element {
  const panelEl = untrack(() => props.panel);
  let handle: HTMLDivElement | undefined;
  let dragging = false;

  const stop = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.body.style.userSelect = "";
  };
  trackDrag({
    move: (e) => {
      const panel = panelEl();
      if (!dragging || panel === undefined) {
        return;
      }
      if (props.dock === "right") {
        const newWidth = window.innerWidth - e.clientX;
        const clamped = Math.max(
          MIN_RIGHT_WIDTH_PX,
          Math.min(newWidth, window.innerWidth * MAX_VIEWPORT_SHARE),
        );
        panel.style.width = `${String(clamped)}px`;
      } else {
        const newHeight = window.innerHeight - e.clientY;
        const clamped = Math.max(
          MIN_BOTTOM_HEIGHT_PX,
          Math.min(newHeight, window.innerHeight * MAX_VIEWPORT_SHARE),
        );
        panel.style.height = `${String(clamped)}px`;
      }
      props.onResize();
    },
    up: stop,
  });
  onCleanup(stop);

  return (
    <div
      class="td-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      ref={(el) => {
        handle = el;
      }}
      onPointerDown={(e) => {
        if (props.collapsed) {
          return;
        }
        dragging = true;
        handle?.setPointerCapture(e.pointerId);
        document.body.style.userSelect = "none";
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
export function BodySplitter(props: {
  panel: () => HTMLElement | undefined;
  dock: DockPosition;
}): JSX.Element {
  const panelEl = untrack(() => props.panel);
  let splitter: HTMLDivElement | undefined;
  let dragging = false;

  const stop = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    splitter?.classList.remove("dragging");
    document.body.style.userSelect = "";
  };
  trackDrag({
    move: (e) => {
      const panel = panelEl();
      if (!dragging || panel === undefined) {
        return;
      }
      const bodyRect = splitter?.parentElement?.getBoundingClientRect();
      if (bodyRect === undefined) {
        return;
      }
      if (props.dock === "right") {
        const relY = e.clientY - bodyRect.top;
        const maxTop = Math.max(
          MIN_PRIMARY_PX,
          bodyRect.height - MIN_SECONDARY_PX - SPLITTER_PX,
        );
        const clamped = Math.max(MIN_PRIMARY_PX, Math.min(relY, maxTop));
        panel.style.setProperty("--td-top-height", `${String(clamped)}px`);
      } else {
        const relX = e.clientX - bodyRect.left;
        const maxLeft = Math.max(
          MIN_PRIMARY_PX,
          bodyRect.width - MIN_SECONDARY_PX - SPLITTER_PX,
        );
        const clamped = Math.max(MIN_PRIMARY_PX, Math.min(relX, maxLeft));
        panel.style.setProperty("--td-left-width", `${String(clamped)}px`);
      }
    },
    up: stop,
  });
  onCleanup(stop);

  return (
    <div
      class="td-body-splitter"
      role="separator"
      aria-orientation="vertical"
      tabindex="-1"
      title="Drag to resize"
      ref={(el) => {
        splitter = el;
      }}
      onPointerDown={(e) => {
        dragging = true;
        splitter?.setPointerCapture(e.pointerId);
        splitter?.classList.add("dragging");
        document.body.style.userSelect = "none";
      }}
      onDblClick={() => {
        const panel = panelEl();
        panel?.style.removeProperty("--td-left-width");
        panel?.style.removeProperty("--td-top-height");
      }}
    />
  );
}
