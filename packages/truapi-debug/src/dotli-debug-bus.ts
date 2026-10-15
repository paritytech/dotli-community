// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bus is off until `enableDotliDebugBuffering()`, so sessions that never open debug mode pay nothing.

import { reportListener } from '@dotli/metrics';
import { createListenerSet, noop } from '@dotli/shared';

import type { DotliDebugEvent, TruapiDebugMessageEvent } from './dotli-debug-types.js';

export type DotliDebugBusEvent = DotliDebugEvent | TruapiDebugMessageEvent;

export interface DotliDebugBus {
  /** Call as soon as the panel is known to mount, before any emit site runs. */
  enableBuffering(): void;
  emit(event: DotliDebugBusEvent): void;
  /** Cheap gate for emit sites that build non-trivial payloads. */
  hasListeners(): boolean;
  /** For host code that reacts to an event without being a panel. Sees nothing while the bus is off. */
  watch(callback: (event: DotliDebugBusEvent) => void): () => void;
  on(callback: (event: DotliDebugBusEvent) => void): () => void;
}

// Boot events fire while the lazily loaded panel is still loading. They are held until the first
// subscriber attaches, replayed to it once, and then buffering stops for the session.
const BUFFER_MAX = 512;

/** Builds an independent bus. The page keeps one, and a test builds its own. */
export function createDotliDebugBus(): DotliDebugBus {
  let enabled = false;
  let bufferingEnabled = false;
  let bufferedEvents: DotliDebugBusEvent[] = [];
  const listeners = createListenerSet<DotliDebugBusEvent>({ onListenerError: reportListener('ui', 'debug_bus.live') });
  // Watchers see live events only. They are not listeners, so they neither take the boot replay from the panel nor turn
  // on the emit sites gated by `hasListeners`.
  const watchers = createListenerSet<DotliDebugBusEvent>({ onListenerError: reportListener('ui', 'debug_bus.watch') });
  // Never subscribed: it delivers the boot replay to the first panel under its own owner.
  const replays = createListenerSet<DotliDebugBusEvent>({ onListenerError: reportListener('ui', 'debug_bus.replay') });

  return {
    enableBuffering() {
      enabled = true;
      bufferingEnabled = true;
    },
    emit(event) {
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
    },
    hasListeners: () => enabled && listeners.size > 0,
    watch: watchers.subscribe,
    on(callback) {
      if (!enabled) {
        return noop;
      }
      const wasCold = listeners.size === 0;
      const unsubscribe = listeners.subscribe(callback);
      if (wasCold && bufferedEvents.length > 0) {
        const replay = bufferedEvents;
        bufferedEvents = [];
        bufferingEnabled = false;
        for (const event of replay) {
          replays.deliver(callback, event);
        }
      }
      return unsubscribe;
    },
  };
}

const pageBus = createDotliDebugBus();

export const enableDotliDebugBuffering = (): void => {
  pageBus.enableBuffering();
};
export const emitDotliDebugEvent = (event: DotliDebugBusEvent): void => {
  pageBus.emit(event);
};
export const hasDotliDebugListeners = (): boolean => pageBus.hasListeners();
export const watchDotliDebugEvents = (callback: (event: DotliDebugBusEvent) => void): (() => void) =>
  pageBus.watch(callback);
export const onDotliDebugEvent = (callback: (event: DotliDebugBusEvent) => void): (() => void) => pageBus.on(callback);
