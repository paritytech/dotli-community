// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { EventStore } from './model/eventStore.js';
import { createResolutionRecorder, type ResolutionRecorder } from './model/resolutionView.js';
import type { DebugBus, DebugBusEvent } from '@dotli/truapi-debug';

/** What the panel shows, fed from the bus. */
export type PanelFeed = {
  store: EventStore;
  resolution: ResolutionRecorder;
  /** Stops feeding. The store and recorder keep what they have. */
  unsubscribe: () => void;
};

function isTruapiDebugEvent(ev: DebugBusEvent): ev is Extract<DebugBusEvent, { kind: 'truapi' }> {
  return 'kind' in ev;
}

/**
 * Subscribes to `bus` at once, so the buffered boot replay is in the store before the panel mounts rather than a frame
 * later.
 */
export function createPanelFeed(options: { bus: Pick<DebugBus, 'subscribe'>; capacity: number }): PanelFeed {
  const store = new EventStore({ capacity: options.capacity });
  const resolution = createResolutionRecorder();
  const unsubscribe = options.bus.subscribe(ev => {
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
  return { store, resolution, unsubscribe };
}
