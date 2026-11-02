// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drags write inline styles on the panel directly, without a render. Nothing on the move path reads layout,
// so a drag never forces a synchronous reflow.

import { onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from './model/createDockStorage.js';
import { clampPanelSize } from './clampPanelSize.js';
import { clampSplit } from './clampSplit.js';
import type { Orientation } from './getKeyDelta.js';
import { getPanelSizeBounds } from './getPanelSizeBounds.js';
import { getSplitBounds } from './getSplitBounds.js';
import { stepPanelSize } from './stepPanelSize.js';
import { Resizer } from './shared/Resizer.js';
import s from './Resizers.module.css';

type WritePanelSizeParams = {
  dock: DockPosition;
  /** The size along the drag axis, in px. */
  size: number;
};

/** The panel's custom property that holds the split, for each orientation of the body. */
const SPLIT_PROPERTIES = { stacked: '--td-top-height', sideBySide: '--td-left-width' } as const;

/** Top edge (bottom dock) or left edge (right dock) of the panel. */
export function ResizeHandle(props: {
  panel: () => HTMLElement | undefined;
  collapsed: boolean;
  dock: DockPosition;
  /** Size along the drag axis, at most once per frame. */
  onResize: (size: number) => void;
}): JSX.Element {
  const getPanel = untrack(() => props.panel);
  let resized: number | null = null;
  let frame: number | null = null;
  onCleanup(() => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  });

  function dragEdge(event: PointerEvent): void {
    const panel = getPanel();
    if (panel === undefined) {
      return;
    }
    const clamped = clampPanelSize({
      dock: props.dock,
      pointer: { x: event.clientX, y: event.clientY },
      viewport: readViewport(),
    });
    writePanelSize(panel, { dock: props.dock, size: clamped });
    resized = clamped;
    frame ??= requestAnimationFrame(() => {
      frame = null;
      if (resized !== null) {
        props.onResize(resized);
        resized = null;
      }
    });
  }

  return (
    <Resizer
      testId="td-resize-handle"
      class={s['handle']}
      orientation={getHandleOrientation(props.dock)}
      label="Resize the panel"
      disabled={props.collapsed}
      onDrag={dragEdge}
      onKeyMove={delta => {
        const panel = getPanel();
        if (panel === undefined) {
          return;
        }
        // The edge is the panel's start, so moving it up or left grows the panel.
        const size = stepPanelSize({
          dock: props.dock,
          size: readPanelSize(panel, props.dock),
          grow: -delta,
          viewport: readViewport(),
        });
        writePanelSize(panel, { dock: props.dock, size });
        props.onResize(size);
      }}
      measure={() => {
        const panel = getPanel();
        return {
          now: panel === undefined ? 0 : readPanelSize(panel, props.dock),
          ...getPanelSizeBounds(props.dock, readViewport()),
        };
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
  const getPanel = untrack(() => props.panel);
  /** Measured once at drag start, since measuring per move would read layout after a write. */
  let body: DOMRect | undefined;

  function dragSplit(event: PointerEvent): void {
    const panel = getPanel();
    if (panel === undefined || body === undefined) {
      return;
    }
    const offset = props.stacked ? event.clientY - body.top : event.clientX - body.left;
    const span = props.stacked ? body.height : body.width;
    panel.style.setProperty(getSplitProperty(props.stacked), `${String(clampSplit(offset, span))}px`);
  }

  return (
    <Resizer
      testId="td-body-splitter"
      class={s['splitter']}
      orientation={props.stacked ? 'horizontal' : 'vertical'}
      hidden={props.hidden}
      label="Resize the panes"
      title="Drag to resize"
      onDragStart={splitter => {
        body = splitter.parentElement?.getBoundingClientRect();
      }}
      onDrag={dragSplit}
      onKeyMove={(delta, splitter) => {
        const panel = getPanel();
        if (panel === undefined) {
          return;
        }
        const { now, span } = measureSplit(splitter, props.stacked);
        panel.style.setProperty(getSplitProperty(props.stacked), `${String(clampSplit(now + delta, span))}px`);
      }}
      measure={splitter => {
        const { now, span } = measureSplit(splitter, props.stacked);
        return { now, ...getSplitBounds(span) };
      }}
      onReset={() => {
        const panel = getPanel();
        if (panel !== undefined) {
          clearSplit(panel);
        }
      }}
    />
  );
}

/**
 * Drops the split's inline sizes, so both panes take their CSS defaults. Never throws.
 * CAUTION: writes into `panel`'s inline style.
 */
export function clearSplit(panel: HTMLElement): void {
  for (const property of Object.values(SPLIT_PROPERTIES)) {
    panel.style.removeProperty(property);
  }
}

/**
 * Drops the panel's inline size on both axes, so it takes its CSS default. Never throws.
 * CAUTION: writes into `panel`'s inline style.
 */
export function clearPanelSize(panel: HTMLElement): void {
  panel.style.width = '';
  panel.style.height = '';
}

/**
 * Drops the panel's inline height and returns what it held, an empty string when it held none. Never throws.
 * CAUTION: writes into `panel`'s inline style.
 */
export function takePanelHeight(panel: HTMLElement): string {
  const height = panel.style.height;
  panel.style.height = '';
  return height;
}

/**
 * Sets the panel's inline height to `height`, and leaves the panel as it is when `height` is empty. Never throws.
 * CAUTION: writes into `panel`'s inline style.
 */
export function restorePanelHeight(panel: HTMLElement, height: string): void {
  if (height === '') {
    return;
  }
  panel.style.height = height;
}

/** The views pane before the splitter and the body around both, along the split axis. */
function measureSplit(splitter: HTMLElement, stacked: boolean): { now: number; span: number } {
  const body = splitter.parentElement;
  const pane = splitter.previousElementSibling;
  if (body === null || !(pane instanceof HTMLElement)) {
    return { now: 0, span: 0 };
  }
  return stacked
    ? { now: pane.offsetHeight, span: body.clientHeight }
    : { now: pane.offsetWidth, span: body.clientWidth };
}

/** The split's size property on the panel: the views' height when stacked, else their width. */
function getSplitProperty(stacked: boolean) {
  return stacked ? SPLIT_PROPERTIES.stacked : SPLIT_PROPERTIES.sideBySide;
}

function readViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Sets the panel's inline size along the dock's drag axis, in px. CAUTION: writes into `panel`'s inline style. */
function writePanelSize(panel: HTMLElement, { dock, size }: WritePanelSizeParams): void {
  panel.style[getSizeProperty(dock)] = `${String(size)}px`;
}

function getSizeProperty(dock: DockPosition): 'width' | 'height' {
  switch (dock) {
    case 'right':
      return 'width';
    case 'bottom':
      return 'height';
  }
}

function getHandleOrientation(dock: DockPosition): Orientation {
  switch (dock) {
    case 'right':
      return 'vertical';
    case 'bottom':
      return 'horizontal';
  }
}

function readPanelSize(panel: HTMLElement, dock: DockPosition): number {
  switch (dock) {
    case 'right':
      return panel.offsetWidth;
    case 'bottom':
      return panel.offsetHeight;
  }
}
