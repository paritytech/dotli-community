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

import { chatButtonVisible, chatPanelStore, initChatPanelState, setChatPanelOpen } from '../state/chat-panel.js';
import { setChatWidth } from '../product-frame-layout.js';
import { ensureChatPanel, prefetchChatPanel } from './load.js';

/**
 * Wire the chat panel to its state. Called once from `initTopBar`. The
 * topbar button is the ChatButton topbar item (components/shell/).
 */
export function initChatPanel(): void {
  const panel = document.getElementById('chat-panel');
  if (panel === null) {
    return;
  }

  initChatPanelState();

  let wasOpen = false;
  let prefetched = false;
  const sync = (): void => {
    const state = chatPanelStore.get();
    panel.hidden = !state.open;
    // The auto-hidden topbar frees its strip; stretch the panel into it.
    panel.classList.toggle('topbar-hidden', !state.topbarVisible);
    if (state.open) {
      panel.style.width = `${String(state.width)}px`;
    }
    if (state.open || wasOpen) {
      // The panel is border-box, so its width is exactly `state.width`.
      setChatWidth(state.open ? state.width : 0);
    }
    wasOpen = state.open;
    if (chatButtonVisible(state) && !prefetched) {
      prefetched = true;
      prefetchChatPanel();
    }
    if (state.open) {
      void ensureChatPanel();
    }
  };
  chatPanelStore.subscribe(sync);
  sync();

  // The chat button takes focus back as the panel closes.
  panel.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      setChatPanelOpen(false);
    }
  });
}
