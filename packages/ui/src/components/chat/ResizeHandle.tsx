// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { persistChatPanelWidth, setChatPanelWidth } from '../../state/chat-panel.js';
import { startDrag } from '../drag.js';

/** Drag handle on the panel's left edge. */
export function ResizeHandle(): JSX.Element {
  let handle: HTMLDivElement | undefined;

  const onPointerDown = (down: PointerEvent): void => {
    const panel = handle?.closest<HTMLElement>('#chat-panel');
    if (handle === undefined || panel === null || panel === undefined) {
      return;
    }
    down.preventDefault();
    const startX = down.clientX;
    const startWidth = panel.offsetWidth;
    startDrag(handle, down, {
      move: move => {
        setChatPanelWidth(startWidth + (startX - move.clientX));
      },
      end: persistChatPanelWidth,
    });
  };

  return (
    <div
      class="chat-panel-resize"
      id="chat-panel-resize"
      aria-hidden="true"
      ref={el => {
        handle = el;
      }}
      onPointerDown={onPointerDown}
    />
  );
}
