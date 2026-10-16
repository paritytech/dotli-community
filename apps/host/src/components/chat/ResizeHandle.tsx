// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '@dotli/ui';
import s from './ResizeHandle.module.css';

/** Drag handle on the panel's left edge. */
export function ResizeHandle(props: {
  id?: string | undefined;
  width: Accessor<number>;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
}): JSX.Element {
  let handle: HTMLDivElement | undefined;
  const drags = createDrags();
  onCleanup(drags.stopAll);

  const onPointerDown = (down: PointerEvent): void => {
    if (handle === undefined) {
      return;
    }
    down.preventDefault();
    const startX = down.clientX;
    // The panel is border-box: its width is the prop's.
    const startWidth = props.width();
    drags.start(handle, down, {
      move: move => {
        props.onResize(startWidth + (startX - move.clientX));
      },
      end: props.onResizeEnd,
    });
  };

  return (
    <div
      class={s['handle']}
      id={props.id}
      aria-hidden="true"
      ref={el => {
        handle = el;
      }}
      onPointerDown={onPointerDown}
    />
  );
}
