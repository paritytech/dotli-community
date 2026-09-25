// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid chat panel on first use, so the host startup bundle does
// not carry it. Solid-free: it only imports the chunk dynamically.

import { captureException } from "@dotli/metrics/sentry";
import { setChatPanelOpen } from "../state/chat-panel";

const PREFETCH_FALLBACK_MS = 2000;

let loading: Promise<void> | null = null;
let dispose: (() => void) | null = null;

/** A render error inside the panel: close it and remount on the next open. */
function createOnBroken(): () => void {
  let handled = false;
  return () => {
    if (handled) {
      return;
    }
    handled = true;
    // Deferred so the root is not disposed from inside its own fallback.
    queueMicrotask(() => {
      loading = null;
      dispose?.();
      dispose = null;
      setChatPanelOpen(false);
    });
  };
}

/** Import and mount the chat panel once. Never rejects. */
export function ensureChatPanel(): Promise<void> {
  loading ??= import("../components/chat/mount")
    .then(({ mountChatPanel }) => {
      dispose = mountChatPanel(createOnBroken());
    })
    .catch((err: unknown) => {
      loading = null;
      captureException(err, { kind: "chat_panel_load_error" });
      setChatPanelOpen(false);
    });
  return loading;
}

/** Load the panel when the browser is idle, before the user opens it. */
export function prefetchChatPanel(): void {
  const run = (): void => {
    void ensureChatPanel();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: PREFETCH_FALLBACK_MS });
  } else {
    setTimeout(run, PREFETCH_FALLBACK_MS);
  }
}
