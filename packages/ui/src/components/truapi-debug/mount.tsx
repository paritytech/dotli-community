// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded TrUAPI debug panel. The host imports it
// dynamically, only in debug mode.

import { flush } from "solid-js";
import stylesheetUrl from "@dotli/truapi-debug/styles.css?url";
import {
  onDotliDebugEvent,
  type DotliDebugBusEvent,
} from "@dotli/truapi-debug/dotli-debug-bus";
import { EventStore } from "@dotli/truapi-debug/event-store";
import { restoreIframeLayout } from "@dotli/truapi-debug/iframe-layout";
import { createResolutionRecorder } from "@dotli/truapi-debug/resolution-view";
import { mountRoot } from "../../mount/root";
import { Panel, PANEL_ID } from "./Panel";

const ROOT = "truapi-debug";
const DEFAULT_CAPACITY = 2000;
const STYLE_ID = "truapi-debug-styles";

export interface SetupOptions {
  /** Hard cap on retained events before oldest are evicted. */
  capacity?: number;
  /**
   * Mount the panel collapsed (header-only). Used when debug mode is
   * auto-enabled in dev environments so the panel doesn't cover content
   * unsolicited; explicit opt-ins (Settings button / `?debug=true`)
   * mount expanded.
   */
  startCollapsed?: boolean;
}

function isTruapiDebugEvent(
  ev: DotliDebugBusEvent,
): ev is Extract<DotliDebugBusEvent, { kind: "truapi" }> {
  return "kind" in ev;
}

/** Link the panel stylesheet once per document. */
function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = stylesheetUrl;
  document.head.appendChild(link);
}

/**
 * Install the TrUAPI debug panel into the current document.
 *
 * Creates a single panel bound to the current page, subscribes once to the
 * dotli debug bus, and returns a dispose function that tears everything down
 * (DOM, subscription, timers) and gives the product iframe its full size back.
 *
 * The panel mounts visible whenever debug mode is on. The header's `×` button
 * exits debug mode entirely (clears the session flag and reloads). Re-enter
 * via the host Settings panel's "Open in debug mode" button.
 *
 * Calling twice without disposing is a no-op on the second call.
 */
export function setupTruapiDebugPanel(options: SetupOptions = {}): () => void {
  if (document.getElementById(PANEL_ID) !== null) {
    return () => {
      /* already mounted; owner should dispose the original handle */
    };
  }

  injectStyles();

  const store = new EventStore({
    capacity: options.capacity ?? DEFAULT_CAPACITY,
  });
  const resolution = createResolutionRecorder();

  const container = document.createElement("div");
  document.body.appendChild(container);
  const disposeView = mountRoot(ROOT, container, () => (
    <Panel
      store={store}
      resolution={resolution}
      startCollapsed={options.startCollapsed ?? false}
    />
  ));
  // The panel, its layout and the iframe fit are in place when setup returns.
  flush();

  // Subscribed after the panel so it sees the early-buffer replay this
  // triggers; the replayed events render on the next animation frame.
  const unsubscribe = onDotliDebugEvent((ev) => {
    if (isTruapiDebugEvent(ev)) {
      store.insertTruapi(ev);
    } else {
      // Paused events are dropped by the store; keep the Resolution view
      // consistent with it.
      if (!store.isPaused()) {
        resolution.record(ev);
      }
      store.insertDotli(ev);
    }
  });

  return () => {
    unsubscribe();
    disposeView();
    container.remove();
    restoreIframeLayout();
  };
}
