// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bus stays null until `enableDotliDebugBuffering()`, so sessions that never open debug mode pay nothing.

import { createNanoEvents } from 'nanoevents';

import type { DotliDebugEvent } from './dotli-debug-types.js';
import type { TruapiDebugMessageEvent } from './event-store.js';

export type DotliDebugBusEvent = DotliDebugEvent | TruapiDebugMessageEvent;

let bus: ReturnType<typeof createNanoEvents<{ event: (e: DotliDebugBusEvent) => void }>> | null = null;
let listenerCount = 0;

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
  bus ??= createNanoEvents<{ event: (e: DotliDebugBusEvent) => void }>();
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
