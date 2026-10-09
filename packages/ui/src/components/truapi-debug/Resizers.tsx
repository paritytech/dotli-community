// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drags write inline styles on the panel directly, without a render. Nothing on the move path reads layout,
// so a drag never forces a synchronous reflow.

import { onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from '@dotli/truapi-debug';
import { startDrag } from '../drag.js';
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
      class={s['handle']}
      data-testid="td-resize-handle"
      data-dock={props.dock}
      data-collapsed={props.collapsed ? '' : undefined}
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

/** Divider between the views and the detail pane. Double-click restores the default. */
export function BodySplitter(props: {
  panel: () => HTMLElement | undefined;
  stacked: boolean;
  hidden: boolean;
}): JSX.Element {
  const panelEl = untrack(() => props.panel);
  let splitter: HTMLDivElement | undefined;
  let stopDrag: (() => void) | undefined;
  onCleanup(() => {
    stopDrag?.();
  });

  /** `body` is measured once at drag start, since measuring per move would read layout after a write. */
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
      class={s['splitter']}
      data-testid="td-body-splitter"
      data-layout={props.stacked ? 'stacked' : undefined}
      hidden={props.hidden}
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
        el.setAttribute('data-dragging', '');
        stopDrag = startDrag(el, e, {
          move: m => {
            move(m, body);
          },
          end: () => {
            el.removeAttribute('data-dragging');
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
