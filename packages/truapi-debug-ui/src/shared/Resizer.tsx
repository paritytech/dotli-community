// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A divider the pointer drags or the keyboard moves. It only follows them: the caller turns each move into a size and
// says how big its pane is, which the divider reports to assistive tech.

import { onCleanup, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { startDrag } from '@dotli/ui';
import { keyDelta, type DividerSize } from '../resize-clamp.js';
import s from './Resizer.module.css';

export function Resizer(props: {
  testId: string;
  /** Which way the divider runs. A `horizontal` one resizes up and down. */
  orientation: 'horizontal' | 'vertical';
  /** What moving it resizes, for assistive tech. */
  label: string;
  /** Hidden from view and from the pointer, but still holding its place in the layout. */
  disabled?: boolean;
  hidden?: boolean;
  title?: string;
  class?: string | undefined;
  /** Before the first move, for anything the moves need measured once. */
  onDragStart?: (el: HTMLElement) => void;
  onDrag: (e: PointerEvent) => void;
  /** A key press, `delta` px along the screen axis, right or down positive. */
  onKeyMove: (delta: number, el: HTMLElement) => void;
  /** The pane's size and bounds now. Read on mount, on focus and after a move, never during a drag. */
  measure: (el: HTMLElement) => DividerSize;
  /** On double-click, back to the default size. */
  onReset?: () => void;
}): JSX.Element {
  let el: HTMLDivElement | undefined;
  let stopDrag: (() => void) | undefined;
  onCleanup(() => {
    stopDrag?.();
  });

  // Written straight to the node, as the drags write the panel, so a move costs no render.
  const report = (): void => {
    if (el === undefined) {
      return;
    }
    const size = props.measure(el);
    el.setAttribute('aria-valuenow', String(Math.round(size.now)));
    el.setAttribute('aria-valuemin', String(Math.round(size.min)));
    el.setAttribute('aria-valuemax', String(Math.round(size.max)));
  };
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
        el = node;
      }}
      onFocus={report}
      onKeyDown={e => {
        const delta = keyDelta(e.key, props.orientation, e.shiftKey, e.altKey || e.ctrlKey || e.metaKey);
        const target = el;
        if (delta === null || props.disabled === true || target === undefined) {
          return;
        }
        e.preventDefault();
        props.onKeyMove(delta, target);
        report();
      }}
      onPointerDown={e => {
        const target = el;
        if (props.disabled === true || target === undefined) {
          return;
        }
        props.onDragStart?.(target);
        target.setAttribute('data-dragging', '');
        stopDrag = startDrag(target, e, {
          move: props.onDrag,
          end: () => {
            target.removeAttribute('data-dragging');
            report();
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
