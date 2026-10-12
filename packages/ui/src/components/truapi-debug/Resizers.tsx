// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drags write inline styles on the panel directly, without a render. Nothing on the move path reads layout,
// so a drag never forces a synchronous reflow.

import { onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from '@dotli/truapi-debug';
import { Resizer } from './shared/Resizer.js';
import s from './Resizers.module.css';

/** Room for the filter chips and tabs. */
const MIN_PRIMARY_PX = 220;
/** Room for the detail key-value list. */
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
  /** Size along the drag axis, at most once per frame. */
  onResize: (px: number) => void;
}): JSX.Element {
  const panelEl = untrack(() => props.panel);
  let resized: number | null = null;
  let frame: number | null = null;
  onCleanup(() => {
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
    <Resizer
      testId="td-resize-handle"
      class={s['handle']}
      orientation={props.dock === 'right' ? 'vertical' : 'horizontal'}
      disabled={props.collapsed}
      onDrag={move}
    />
  );
}

/** Divider between the views and the detail pane. Double-click restores the default. */
export function BodySplitter(props: {
  panel: () => HTMLElement | undefined;
  stacked: boolean;
  hidden: boolean;
}): JSX.Element {
  const panelEl = untrack(() => props.panel);
  /** Measured once at drag start, since measuring per move would read layout after a write. */
  let body: DOMRect | undefined;

  const move = (e: PointerEvent): void => {
    const panel = panelEl();
    if (panel === undefined || body === undefined) {
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
    <Resizer
      testId="td-body-splitter"
      class={s['splitter']}
      orientation={props.stacked ? 'horizontal' : 'vertical'}
      hidden={props.hidden}
      title="Drag to resize"
      onDragStart={el => {
        body = el.parentElement?.getBoundingClientRect();
      }}
      onDrag={move}
      onReset={() => {
        const panel = panelEl();
        panel?.style.removeProperty('--td-left-width');
        panel?.style.removeProperty('--td-top-height');
      }}
    />
  );
}
