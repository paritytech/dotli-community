// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bus stays null until `enableDotliDebugBuffering()`, so sessions that never open debug mode pay nothing.

import { createNanoEvents, type Emitter } from 'nanoevents';

import type { DotliDebugEvent, PolkaVmDebugSnapshot } from './dotli-debug-types.js';
import type { TruapiDebugMessageEvent } from './event-store.js';

export type DotliDebugBusEvent = DotliDebugEvent | TruapiDebugMessageEvent;

interface DebugBusEvents {
  event: (event: DotliDebugBusEvent) => void;
  polkavm: (snapshot: PolkaVmDebugSnapshot | null) => void;
}

let bus: Emitter<DebugBusEvents> | null = null;
let listenerCount = 0;
let latestPolkaVmSnapshot: PolkaVmDebugSnapshot | null = null;
let polkaVmListenerCount = 0;

// Boot events fire while the lazily loaded panel is still loading. They are held until the first
// subscriber attaches, replayed to it once, and then buffering stops for the session.
const BUFFER_MAX = 512;
let bufferingEnabled = false;
let bufferedEvents: DotliDebugBusEvent[] = [];

function noopUnsubscribe(): void {
  /* returned while the bus is disabled */
}

/** Call as soon as the panel is known to mount, before any emit site runs. */
export function enableDotliDebugBuffering(): void {
  bus ??= createNanoEvents<DebugBusEvents>();
  bufferingEnabled = true;
}

export function emitDotliDebugEvent(event: DotliDebugBusEvent): void {
  if (bus === null) {
    return;
  }
  if (listenerCount > 0) {
    bus.emit('event', event);
    return;
  }
  if (bufferingEnabled) {
    bufferedEvents.push(event);
    if (bufferedEvents.length > BUFFER_MAX) {
      bufferedEvents.shift();
    }
  }
}

/** Publish the latest PolkaVM runtime state without adding a sampled value to
 * the event timeline. Silent no-op outside debug mode. */
export function emitPolkaVmDebugSnapshot(snapshot: PolkaVmDebugSnapshot): void {
  if (bus === null) {
    return;
  }
  latestPolkaVmSnapshot = snapshot;
  if (polkaVmListenerCount > 0) {
    bus.emit('polkavm', snapshot);
  }
}

/** Forget the previous product's metrics, including the late-subscriber replay. */
export function clearPolkaVmDebugSnapshot(): void {
  latestPolkaVmSnapshot = null;
  if (bus !== null && polkaVmListenerCount > 0) {
    bus.emit('polkavm', null);
  }
}

/** Subscribe to live PolkaVM runtime state. The current snapshot is replayed
 * immediately so a dynamically imported panel cannot miss startup metrics. */
export function onPolkaVmDebugSnapshot(callback: (snapshot: PolkaVmDebugSnapshot | null) => void): () => void {
  if (bus === null) {
    return noopUnsubscribe;
  }
  const unsubscribe = bus.on('polkavm', callback);
  polkaVmListenerCount++;
  if (latestPolkaVmSnapshot !== null) {
    callback(latestPolkaVmSnapshot);
  }
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    polkaVmListenerCount--;
    unsubscribe();
  };
}

/** Cheap gate for emit sites that build non-trivial payloads. */
export function hasDotliDebugListeners(): boolean {
  if (bus === null) {
    return false;
  }
  return listenerCount > 0;
}

export function onDotliDebugEvent(callback: (event: DotliDebugBusEvent) => void): () => void {
  if (bus === null) {
    return noopUnsubscribe;
  }
  const wasCold = listenerCount === 0;
  listenerCount++;
  const unsub = bus.on('event', callback);
  if (wasCold && bufferedEvents.length > 0) {
    const replay = bufferedEvents;
    bufferedEvents = [];
    bufferingEnabled = false;
    for (const e of replay) {
      try {
        callback(e);
        // eslint-disable-next-line no-restricted-syntax -- replay errors must not break bus emission; same policy as nanoevents.
      } catch {
        /* swallow */
      }
    }
  }
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    listenerCount = Math.max(0, listenerCount - 1);
    unsub();
  };
}
