// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from "@solidjs/web";
import {
  persistChatPanelWidth,
  setChatPanelWidth,
} from "../../state/chat-panel";

/** Drag handle on the panel's left edge. */
export function ResizeHandle(): JSX.Element {
  let handle: HTMLDivElement | undefined;

  const onPointerDown = (down: PointerEvent): void => {
    const panel = handle?.closest<HTMLElement>("#chat-panel");
    if (handle === undefined || panel === null || panel === undefined) {
      return;
    }
    const target = handle;
    down.preventDefault();
    target.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = panel.offsetWidth;
    const onMove = (move: PointerEvent): void => {
      setChatPanelWidth(startWidth + (startX - move.clientX));
    };
    // pointercancel is never followed by pointerup, so both ends of the drag
    // must detach the listeners or they leak and act on later hovers.
    const onEnd = (): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      persistChatPanelWidth();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  };

  return (
    <div
      class="chat-panel-resize"
      id="chat-panel-resize"
      aria-hidden="true"
      ref={(el) => {
        handle = el;
      }}
      onPointerDown={onPointerDown}
    />
  );
}
