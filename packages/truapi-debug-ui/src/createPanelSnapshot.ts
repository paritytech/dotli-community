// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The store is not reactive, so the panel draws from a copy of it, taken at most once per frame and at once when the
// panel asks.

import { createSignal, onCleanup, untrack, type Accessor } from 'solid-js';
import type { EventStore } from './model/createEventStore.js';
import type { ResolutionRecorder } from './model/createResolutionRecorder.js';
import { sortProducts } from './model/sortProducts.js';
import type { StoredEvent } from './model/storedEvent.js';

type Snapshot = {
  events: readonly StoredEvent[];
  dropped: number;
  paused: boolean;
  /** Sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  version: number;
  /** The recorder's version, so the Resolution view redraws with the frame that brought its events. */
  resolutionVersion: number;
  takenAt: number;
};

type Params = {
  store: EventStore;
  recorder: ResolutionRecorder;
  /** Whether the panel is folded. A folded panel takes no snapshot on a frame. */
  collapsed: Accessor<boolean>;
  /** Runs a frame's refresh the way the panel runs its own updates. */
  apply: (update: () => void) => void;
};

/**
 * The panel's copy of the store and the recorder. Call it inside the panel's owner, which ends its store listener and
 * pending frame.
 */
export function createPanelSnapshot({ store, recorder, collapsed, apply }: Params) {
  const [snapshot, setSnapshot] = createSignal<Snapshot>(take());

  let frame: number | null = null;
  const unlistenStore = store.version.listen(() => {
    if (frame !== null) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      // A collapsed panel shows nothing of the log, and expanding takes a snapshot.
      if (!collapsed()) {
        apply(refresh);
      }
    });
  });
  onCleanup(() => {
    unlistenStore();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  });

  return {
    /** The last copy taken. */
    snapshot,
    /** Takes a new copy when the store or the recorder changed since the last one. Never throws. */
    refresh,
  };

  function take(): Snapshot {
    return {
      // A snapshot holds still while traffic keeps arriving.
      events: store.list().slice(),
      dropped: store.dropped(),
      paused: store.isPaused(),
      products: sortProducts(store.productIds()),
      version: store.version.get(),
      resolutionVersion: recorder.version(),
      takenAt: Date.now(),
    };
  }

  function refresh(): void {
    const last = untrack(snapshot);
    if (store.version.get() !== last.version || recorder.version() !== last.resolutionVersion) {
      setSnapshot(take());
    }
  }
}
