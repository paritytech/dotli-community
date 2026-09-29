// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid chat panel on first use, so the host startup bundle does
// not carry it. Solid-free: it only imports the chunk dynamically.

import { createLazyRoot } from "../mount/lazy-root.js";
import { setChatPanelOpen } from "../state/chat-panel.js";

/**
 * The chat panel root. If the chunk cannot load, or the panel throws while
 * rendering, the panel closes and the next open mounts it afresh.
 */
const chatPanel = createLazyRoot({
  load: (onBroken) =>
    import("../components/chat/mount.js").then(({ mountChatPanel }) =>
      mountChatPanel(onBroken),
    ),
  errorKind: "chat_panel_load_error",
  onFailure: () => {
    setChatPanelOpen(false);
  },
});

/** Import and mount the chat panel once. Never rejects. */
export const ensureChatPanel = chatPanel.ensure;

/** Load the panel when the browser is idle, before the user opens it. */
export const prefetchChatPanel = chatPanel.prefetch;
