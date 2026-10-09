// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded TrUAPI debug panel. The host imports the chunk
// with its CSS-module stylesheet, so dock measurements run only after CSS is
// ready.

import { flush } from 'solid-js';
import { DEBUG } from '@dotli/config';
import type { ExperimentalWalletControls } from '@dotli/truapi-debug';
import { onDotliDebugEvent, type DotliDebugBusEvent, EventStore, createResolutionRecorder } from '@dotli/truapi-debug';

import { mountRoot } from '../../mount/root.js';
import { Panel, PANEL_ID } from './Panel.js';
import { productArchiveLoader, type BlockSource } from './archive-source.js';

const ROOT = 'truapi-debug';
const DEFAULT_CAPACITY = 2000;

export interface SetupOptions {
  /** Retained events before the oldest are evicted. */
  capacity?: number;
  /** Set when debug mode is auto-enabled in dev, so the panel does not cover content unasked. */
  startCollapsed?: boolean;
  /** Compile-time debug builds only; runtime debug opt-ins cannot enable custody. */
  experimentalWallet?: ExperimentalWalletControls;
  /**
   * Where the Archive tab reads blocks on the light client: the host's own
   * source, cache first. Without one it reads over the IPFS gateway.
   */
  blockSource?: BlockSource;
}

function isTruapiDebugEvent(ev: DotliDebugBusEvent): ev is Extract<DotliDebugBusEvent, { kind: 'truapi' }> {
  return 'kind' in ev;
}

/**
 * Install the debug panel, returning a dispose that also gives the product iframe its full size back.
 *
 * A second call before disposing is a no-op.
 */
export function setupTruapiDebugPanel(options: SetupOptions = {}): () => void {
  if (document.getElementById(PANEL_ID) !== null) {
    return () => {
      /* already mounted, the owner disposes the original handle */
    };
  }

  const store = new EventStore({
    capacity: options.capacity ?? DEFAULT_CAPACITY,
  });
  const resolution = createResolutionRecorder();

  const container = document.createElement('div');
  document.body.appendChild(container);

  // Subscribed before mount so the buffered boot replay is in the panel's first snapshot, not a frame later.
  const unsubscribe = onDotliDebugEvent(ev => {
    if (isTruapiDebugEvent(ev)) {
      store.insertTruapi(ev);
    } else {
      // The store drops paused events, so the Resolution view does too.
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
        loadArchive={productArchiveLoader(options.blockSource)}
      />
    ),
    // A render error, even a late one, tears the panel down rather than leave it frozen with timers running.
    { onBroken: unsubscribe, removeContainer: true },
  );
  // Callers expect the panel, its layout and the iframe fit in place on return.
  flush();

  return () => {
    unsubscribe();
    disposeView();
  };
}
