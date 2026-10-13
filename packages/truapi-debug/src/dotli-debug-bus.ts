// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bus stays null until `enableDotliDebugBuffering()`, so sessions that never open debug mode pay nothing.

import { createNanoEvents } from 'nanoevents';
import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';

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

function noopUnsubscribe(): void {
  /* returned while the bus is disabled */
}

// Boot events fire while the lazily loaded panel is still loading. They are held until the first
// subscriber attaches, replayed to it once, and then buffering stops for the session.
const BUFFER_MAX = 512;

/** A throwing receiver is a defect in its subscriber, so it is reported, and the other receivers still get the event. */
function deliver(
  delivery: 'replay' | 'watch',
  receiver: (event: DotliDebugBusEvent) => void,
  event: DotliDebugBusEvent,
): void {
  try {
    receiver(event);
  } catch (err: unknown) {
    captureException(err, { flow: 'ui', step: 'debug_bus_listener', tags: { delivery } });
    log.error(`[dot.li debug-bus] A debug bus ${delivery} receiver threw`, err);
    m.count(S.DEBUG_BUS_LISTENER, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
  }
}

/** Builds an independent bus. The page keeps one, and a test builds its own. */
export function createDotliDebugBus(): DotliDebugBus {
  let bus: ReturnType<typeof createNanoEvents<{ event: (e: DotliDebugBusEvent) => void }>> | null = null;
  let listenerCount = 0;
  let bufferingEnabled = false;
  let bufferedEvents: DotliDebugBusEvent[] = [];

  // Watchers see live events only. They are not listeners, so they neither take the boot replay from the panel nor turn
  // on the emit sites gated by `hasListeners`.
  const watchers = new Set<(event: DotliDebugBusEvent) => void>();

  return {
    enableBuffering() {
      bus ??= createNanoEvents<{ event: (e: DotliDebugBusEvent) => void }>();
      bufferingEnabled = true;
    },
    emit(event) {
      if (bus === null) {
        return;
      }
      for (const watcher of [...watchers]) {
        deliver('watch', watcher, event);
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
    },
    hasListeners() {
      if (bus === null) {
        return false;
      }
      return listenerCount > 0;
    },
    watch(callback) {
      watchers.add(callback);
      return () => {
        watchers.delete(callback);
      };
    },
    on(callback) {
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
          deliver('replay', callback, e);
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
