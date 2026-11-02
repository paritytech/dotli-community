// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A divider the pointer drags or the keyboard moves. It only follows them: the caller turns each move into a size and
// says how big its pane is, which the divider reports to assistive tech.

import { onCleanup, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '@dotli/ui';
import { getKeyDelta, type Orientation } from '../getKeyDelta.js';
import type { DividerSize } from '../stepPanelSize.js';
import s from './Resizer.module.css';

export function Resizer(props: {
  testId: string;
  /** Which way the divider runs. A `horizontal` one resizes up and down. */
  orientation: Orientation;
  /** What moving it resizes, for assistive tech. */
  label: string;
  /** Hidden from view and from the pointer, but still holding its place in the layout. */
  disabled?: boolean;
  hidden?: boolean;
  title?: string;
  class?: string | undefined;
  /** Before the first move, for anything the moves need measured once. */
  onDragStart?: (element: HTMLElement) => void;
  onDrag: (event: PointerEvent) => void;
  /** A key press, `delta` px along the screen axis, right or down positive. */
  onKeyMove: (delta: number, element: HTMLElement) => void;
  /** The pane's size and bounds now. Read on mount, on focus and after a move, never during a drag. */
  measure: (element: HTMLElement) => DividerSize;
  /** On double-click, back to the default size. */
  onReset?: () => void;
}): JSX.Element {
  let element: HTMLDivElement | undefined;
  const drags = createDrags();
  onCleanup(drags.stopAll);

  // Written straight to the node, as the drags write the panel, so a move costs no render.
  function report(): void {
    if (element === undefined) {
      return;
    }
    const size = props.measure(element);
    element.setAttribute('aria-valuenow', String(Math.round(size.now)));
    element.setAttribute('aria-valuemin', String(Math.round(size.min)));
    element.setAttribute('aria-valuemax', String(Math.round(size.max)));
  }
  onSettled(report);

  return (
    <div
      class={[s['resizer'], props.class]}
      data-testid={props.testId}
      data-orientation={props.orientation}
      data-disabled={props.disabled === true ? '' : undefined}
      hidden={props.hidden}
      role="separator"
      aria-orientation={props.orientation}
      aria-label={props.label}
      tabindex="0"
      title={props.title}
      ref={node => {
        element = node;
      }}
      onFocus={report}
      onKeyDown={event => {
        const delta = getKeyDelta({
          key: event.key,
          orientation: props.orientation,
          large: event.shiftKey,
          modified: event.altKey || event.ctrlKey || event.metaKey,
        });
        const target = element;
        if (delta === null || props.disabled === true || target === undefined) {
          return;
        }
        event.preventDefault();
        props.onKeyMove(delta, target);
        report();
      }}
      onPointerDown={event => {
        const target = element;
        if (props.disabled === true || target === undefined) {
          return;
        }
        props.onDragStart?.(target);
        target.setAttribute('data-dragging', '');
        drags.start({
          target,
          down: event,
          handlers: {
            move: props.onDrag,
            end() {
              target.removeAttribute('data-dragging');
              report();
            },
          },
        });
      }}
      onDblClick={() => {
        props.onReset?.();
        report();
      }}
    />
  );
}
