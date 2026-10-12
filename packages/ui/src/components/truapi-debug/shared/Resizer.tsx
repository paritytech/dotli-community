// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A draggable divider. It only follows the pointer: the caller turns each move into a size.

import { onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { startDrag } from '../../drag.js';
import s from './Resizer.module.css';

export function Resizer(props: {
  testId: string;
  /** Which way the divider runs. A `horizontal` one resizes up and down. */
  orientation: 'horizontal' | 'vertical';
  /** Hidden from view and from the pointer, but still holding its place in the layout. */
  disabled?: boolean;
  hidden?: boolean;
  title?: string;
  class?: string | undefined;
  /** Before the first move, for anything the moves need measured once. */
  onDragStart?: (el: HTMLElement) => void;
  onDrag: (e: PointerEvent) => void;
  /** On double-click, back to the default size. */
  onReset?: () => void;
}): JSX.Element {
  let el: HTMLDivElement | undefined;
  let stopDrag: (() => void) | undefined;
  onCleanup(() => {
    stopDrag?.();
  });

  return (
    <div
      class={[s['resizer'], props.class]}
      data-testid={props.testId}
      data-orientation={props.orientation}
      data-disabled={props.disabled === true ? '' : undefined}
      hidden={props.hidden}
      role="separator"
      aria-orientation={props.orientation}
      title={props.title}
      ref={node => {
        el = node;
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
          },
        });
      }}
      onDblClick={() => {
        props.onReset?.();
      }}
    />
  );
}
