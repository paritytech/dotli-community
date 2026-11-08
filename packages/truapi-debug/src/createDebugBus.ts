// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bus is off until `enableBuffering()`, so sessions that never open debug mode pay nothing.

import { createReporter } from '@dotli/metrics';
import { createListenerSet, noop } from '@dotli/shared';

import type { DotliDebugEvent, TruapiDebugMessageEvent } from './dotliDebugTypes.js';

const report = createReporter({ flow: 'ui' });

export type DebugBusEvent = DotliDebugEvent | TruapiDebugMessageEvent;

export type DebugBus = ReturnType<typeof createDebugBus>;

// Boot events fire while the lazily loaded panel is still loading. They are held until the first
// subscriber attaches, replayed to it once, and then buffering stops for the session.
const BUFFER_MAX = 512;

/** Builds a debug bus that shares no state with any other, off until `enableBuffering`. */
export function createDebugBus() {
  let enabled = false;
  let bufferingEnabled = false;
  let bufferedEvents: DebugBusEvent[] = [];
  const listeners = createListenerSet<DebugBusEvent>({ onListenerError: report.listener('debug_bus.live') });
  // Watchers see live events only. They are not listeners, so they neither take the boot replay from the panel nor turn
  // on the emit sites gated by `hasListeners`.
  const watchers = createListenerSet<DebugBusEvent>({ onListenerError: report.listener('debug_bus.watch') });
  // Never subscribed: it delivers the boot replay to the first panel under its own owner.
  const replays = createListenerSet<DebugBusEvent>({ onListenerError: report.listener('debug_bus.replay') });

  return {
    /**
     * Turns the bus on and holds events until the first subscriber. Call as soon as the panel is known to mount, before
     * any emit site runs.
     */
    enableBuffering,
    /**
     * Delivers `event` to every watcher and subscriber, and holds it for the first subscriber until one attaches. Does
     * nothing while the bus is off. A throwing receiver is reported and the others still get the event.
     */
    emit,
    /** Whether a subscriber listens on a bus that is on. A cheap gate for emit sites that build non-trivial payloads. */
    hasListeners,
    /**
     * Hears live events, for host code that reacts to an event without being a panel. Sees nothing while the bus is off.
     * Returns the unsubscribe.
     */
    watch,
    /**
     * Hears live events, and the held boot events once when it is the first subscriber. On a bus that is off it hears
     * nothing and returns an unsubscribe that does nothing.
     */
    subscribe,
  };

  function enableBuffering(): void {
    enabled = true;
    bufferingEnabled = true;
  }

  function emit(event: DebugBusEvent): void {
    if (!enabled) {
      return;
    }
    watchers.emit(event);
    if (listeners.size > 0) {
      listeners.emit(event);
      return;
    }
    if (bufferingEnabled) {
      bufferedEvents.push(event);
      if (bufferedEvents.length > BUFFER_MAX) {
        bufferedEvents.shift();
      }
    }
  }

  function hasListeners(): boolean {
    return enabled && listeners.size > 0;
  }

  function watch(callback: (event: DebugBusEvent) => void): () => void {
    return watchers.subscribe(callback);
  }

  function subscribe(callback: (event: DebugBusEvent) => void): () => void {
    if (!enabled) {
      return noop;
    }
    const wasCold = listeners.size === 0;
    const unsubscribe = listeners.subscribe(callback);
    if (wasCold && bufferedEvents.length > 0) {
      replayBufferedEvents(callback);
    }
    return unsubscribe;
  }

  function replayBufferedEvents(callback: (event: DebugBusEvent) => void): void {
    const replay = bufferedEvents;
    bufferedEvents = [];
    bufferingEnabled = false;
    for (const event of replay) {
      replays.deliver(callback, event);
    }
  }
}
