// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Docked product-chat panel: the Solid-free part that runs at boot.
//
// The topbar button appears when the loaded product declares chat in its
// worker manifest (announced via `dotli:chat-availability`) and a session is
// active. The panel docks to the right edge and shrinks the product iframe
// while open (through product-frame-layout), mirroring the debug panel's
// right dock. Its contents are Solid components loaded on first use
// (components/chat/ChatPanel.tsx).

import {
  chatButtonVisible,
  chatPanelStore,
  chatUnreadLabel,
  initChatPanelState,
  setChatPanelOpen,
  totalChatUnread,
} from "../state/chat-panel";
import { setChatWidth } from "../product-frame-layout";
import { ensureChatPanel, prefetchChatPanel } from "./load";

/** Wire the chat button + panel. Called once from `initTopBar`. */
export function initChatPanel(): void {
  const button = document.getElementById("chat-button");
  const moreRow = document.getElementById("more-row-chat");
  const badge = document.getElementById("chat-unread-badge");
  const panel = document.getElementById("chat-panel");
  if (button === null || moreRow === null || badge === null || panel === null) {
    return;
  }

  initChatPanelState();

  let wasOpen = false;
  let prefetched = false;
  const sync = (): void => {
    const state = chatPanelStore.get();
    const visible = chatButtonVisible(state);
    button.hidden = !visible;
    // The static "More" row, until the More island replaces it (the island
    // renders the row from this store; this node is then detached).
    moreRow.hidden = !visible;
    // While the panel is open the room rows carry their own badges.
    const unread = state.open ? 0 : totalChatUnread(state);
    badge.hidden = unread === 0;
    badge.textContent = chatUnreadLabel(unread);
    button.setAttribute("aria-expanded", state.open ? "true" : "false");
    button.classList.toggle("active", state.open);
    panel.hidden = !state.open;
    // The auto-hidden topbar frees its strip; stretch the panel into it.
    panel.classList.toggle("topbar-hidden", !state.topbarVisible);
    if (state.open) {
      panel.style.width = `${String(state.width)}px`;
    }
    if (state.open || wasOpen) {
      // The panel is border-box, so its width is exactly `state.width`.
      setChatWidth(state.open ? state.width : 0);
    }
    wasOpen = state.open;
    if (visible && !prefetched) {
      prefetched = true;
      prefetchChatPanel();
    }
    if (state.open) {
      void ensureChatPanel();
    }
  };
  chatPanelStore.subscribe(sync);
  sync();

  button.addEventListener("click", () => {
    setChatPanelOpen(!chatPanelStore.get().open);
  });
  panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setChatPanelOpen(false);
      button.focus();
    }
  });
}
