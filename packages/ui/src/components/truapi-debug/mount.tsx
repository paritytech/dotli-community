// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded TrUAPI debug panel. The host imports it
// dynamically, only in debug mode.

import { flush } from 'solid-js';
import { DEBUG } from '@dotli/config';
import type { ExperimentalWalletControls } from '@dotli/truapi-debug';
import stylesheetUrl from '@dotli/truapi-debug/styles.css?url';
import { onDotliDebugEvent, type DotliDebugBusEvent, EventStore, createResolutionRecorder } from '@dotli/truapi-debug';

import { mountRoot } from '../../mount/root.js';
import { Panel, PANEL_ID } from './Panel.js';

const ROOT = 'truapi-debug';
const DEFAULT_CAPACITY = 2000;
const STYLE_ID = 'truapi-debug-styles';

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
  /** Compile-time debug builds only; runtime debug opt-ins cannot enable custody. */
  experimentalWallet?: ExperimentalWalletControls;
}

function isTruapiDebugEvent(ev: DotliDebugBusEvent): ev is Extract<DotliDebugBusEvent, { kind: 'truapi' }> {
  return 'kind' in ev;
}

/** Link the panel stylesheet once per document. */
function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
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

  const container = document.createElement('div');
  document.body.appendChild(container);

  // Subscribed before the panel mounts so the synchronous early-buffer
  // replay this subscription triggers lands in the store first: the
  // panel's own store subscription sees inserts regardless of subscribe
  // order, but subscribing first means buffered boot events are already in
  // `store` for the panel's initial snapshot, so they render immediately
  // instead of waiting for the next animation frame.
  const unsubscribe = onDotliDebugEvent(ev => {
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

  const disposeView = mountRoot(
    ROOT,
    container,
    () => (
      <Panel
        store={store}
        resolution={resolution}
        startCollapsed={options.startCollapsed ?? false}
        wallet={DEBUG ? options.experimentalWallet : undefined}
      />
    ),
    // A render error, even a late one, tears the panel down instead of
    // leaving it frozen with its timers running.
    { onBroken: unsubscribe, removeContainer: true },
  );
  // The panel, its layout and the iframe fit are in place when setup returns.
  flush();

  return () => {
    unsubscribe();
    disposeView();
  };
}
