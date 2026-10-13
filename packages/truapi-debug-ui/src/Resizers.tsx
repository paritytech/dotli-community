// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drags write inline styles on the panel directly, without a render. Nothing on the move path reads layout,
// so a drag never forces a synchronous reflow.

import { onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from './model/dock-storage.js';
import { clampPanelSize, clampSplit } from './resize-clamp.js';
import { Resizer } from './shared/Resizer.js';
import s from './Resizers.module.css';

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
    const clamped = clampPanelSize(
      props.dock,
      { x: e.clientX, y: e.clientY },
      { width: window.innerWidth, height: window.innerHeight },
    );
    panel.style[props.dock === 'right' ? 'width' : 'height'] = `${String(clamped)}px`;
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
      panel.style.setProperty('--td-top-height', `${String(clampSplit(e.clientY - body.top, body.height))}px`);
    } else {
      panel.style.setProperty('--td-left-width', `${String(clampSplit(e.clientX - body.left, body.width))}px`);
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
