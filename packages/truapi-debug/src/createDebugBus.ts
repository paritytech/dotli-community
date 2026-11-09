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
// subscriber attaches, replayed to it once, and then buffering ends for the session, whether or not anything was held.
const BUFFER_MAX = 512;

/** Where the bus is in the page's life. Only `buffering` holds events, for the first subscriber. */
type Phase = { kind: 'off' } | { kind: 'buffering'; held: DebugBusEvent[] } | { kind: 'live' };

/** Builds a debug bus that shares no state with any other, off until `enableBuffering`. */
export function createDebugBus() {
  let phase: Phase = { kind: 'off' };
  const listeners = createListenerSet<DebugBusEvent>({ onListenerError: report.listener('debug_bus.live') });
  // Watchers see live events only. They are not listeners, so they neither take the boot replay from the panel nor turn
  // on the emit sites gated by `hasListeners`.
  const watchers = createListenerSet<DebugBusEvent>({ onListenerError: report.listener('debug_bus.watch') });
  // Never subscribed: it delivers the boot replay to the first panel under its own owner.
  const replays = createListenerSet<DebugBusEvent>({ onListenerError: report.listener('debug_bus.replay') });

  return {
    /**
     * Turns the bus on and holds events until the first subscriber. Call as soon as the panel is known to mount, before
     * any emit site runs. A repeat does nothing.
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
     * Hears live events. The first subscriber on a buffering bus also gets the held boot events once and ends buffering,
     * and later subscribers hear live events only. On a bus that is off it hears nothing and returns an unsubscribe that
     * does nothing.
     */
    subscribe,
  };

  function enableBuffering(): void {
    if (phase.kind !== 'off') {
      return;
    }
    phase = { kind: 'buffering', held: [] };
  }

  function emit(event: DebugBusEvent): void {
    if (phase.kind === 'off') {
      return;
    }
    watchers.emit(event);
    // A watcher may have subscribed the first panel, so the phase is read again here.
    routeEvent(event);
  }

  function routeEvent(event: DebugBusEvent): void {
    switch (phase.kind) {
      case 'off':
        return;
      case 'buffering':
        phase.held.push(event);
        if (phase.held.length > BUFFER_MAX) {
          phase.held.shift();
        }
        return;
      case 'live':
        listeners.emit(event);
        return;
    }
  }

  function hasListeners(): boolean {
    return phase.kind === 'live' && listeners.size > 0;
  }

  function watch(callback: (event: DebugBusEvent) => void): () => void {
    return watchers.subscribe(callback);
  }

  function subscribe(callback: (event: DebugBusEvent) => void): () => void {
    switch (phase.kind) {
      case 'off':
        return noop;
      case 'buffering': {
        const { held } = phase;
        phase = { kind: 'live' };
        const unsubscribe = listeners.subscribe(callback);
        for (const event of held) {
          replays.deliver(callback, event);
        }
        return unsubscribe;
      }
      case 'live':
        return listeners.subscribe(callback);
    }
  }
}
