// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEventStore } from './model/createEventStore.js';
import { createResolutionRecorder } from './model/createResolutionRecorder.js';
import type { DebugBus, DebugBusEvent } from '@dotli/truapi-debug';

type Params = {
  /** The bus whose events feed the panel. */
  bus: Pick<DebugBus, 'subscribe'>;
  /** The most events the store keeps. */
  capacity: number;
};

/**
 * What the panel shows, fed from the bus. Subscribes to `bus` at once, so the buffered boot replay is in the store
 * before the panel mounts rather than a frame later.
 */
export function createPanelFeed({ bus, capacity }: Params) {
  const store = createEventStore({ capacity });
  const resolution = createResolutionRecorder();
  const dispose = bus.subscribe(event => {
    if (isTruapiDebugEvent(event)) {
      store.insertTruapi(event);
      return;
    }
    // A paused panel records nothing, the Resolution view included.
    if (!store.isPaused()) {
      resolution.record(event);
    }
    store.insertDotli(event);
  });
  return {
    /** The captured events. */
    store,
    /** The host events of the last page load, held apart from `store`. */
    resolution,
    /** Stops feeding. The store and recorder keep what they have. Never throws. */
    dispose,
  };
}

function isTruapiDebugEvent(event: DebugBusEvent): event is Extract<DebugBusEvent, { kind: 'truapi' }> {
  return 'kind' in event;
}
