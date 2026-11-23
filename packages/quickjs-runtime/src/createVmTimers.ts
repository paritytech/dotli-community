// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The VM's timers and `queueMicrotask`, run on the host's. Each callback runs the jobs it queued after it, since a VM
// runs a job only when the host asks.

import type { Timers } from '@dotli/shared';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';

import { defineVmFunctions } from './defineVmFunctions.js';
import { getVmErrorMessage } from './getVmErrorMessage.js';
import { runVmJobs } from './runVmJobs.js';

type Params = {
  vm: QuickJSContext;
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Hears a callback that threw, a job after it that failed, and microtasks dropped past the cap. */
  onError: (error: Error) => void;
};

/** A timer the VM set. `periodMs` is the interval's period, and `null` for a timeout. */
type Scheduled = {
  callback: QuickJSHandle;
  handle: unknown;
  periodMs: number | null;
};

// A flat floor rather than the browser's nesting clamp, so zero-delay timers cannot flood the host's event loop.
const MIN_DELAY_MS = 4;

// A module that queues microtasks in a loop would otherwise flood the host's event loop.
const MAX_PENDING_MICROTASKS = 1024;

/**
 * Sets the VM's `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval` and `queueMicrotask`. Timeouts and
 * intervals share one set of ids, so either clear function clears either kind, as in a browser.
 *
 * Throws when the VM cannot install them.
 */
export function createVmTimers({ vm, timers, onError }: Params) {
  const scheduled = new Map<number, Scheduled>();
  const microtasks = new Set<QuickJSHandle>();
  let nextId = 1;
  let microtaskCapReported = false;
  let disposed = false;

  defineVmFunctions(vm, vm.global, {
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: clear,
    clearInterval: clear,
    queueMicrotask: queue,
  });

  return {
    /** Clears every timer and drops every queued microtask, so no callback reaches the VM after it. Safe to repeat. */
    dispose() {
      disposed = true;
      for (const entry of scheduled.values()) {
        timers.clearTimeout(entry.handle);
        entry.callback.dispose();
      }
      scheduled.clear();
      for (const callback of microtasks) {
        callback.dispose();
      }
      microtasks.clear();
    },
  };

  function schedule(callback: QuickJSHandle | undefined, delay: QuickJSHandle | undefined, repeats: boolean) {
    assertFunction(callback, repeats ? 'setInterval' : 'setTimeout');
    const requested = delay ? Number(vm.dump(delay)) : 0;
    const delayMs = Math.max(Number.isFinite(requested) ? Math.trunc(requested) : 0, MIN_DELAY_MS);
    const id = nextId;
    nextId += 1;
    scheduled.set(id, {
      callback: callback.dup(),
      handle: timers.setTimeout(() => fire(id), delayMs),
      periodMs: repeats ? delayMs : null,
    });
    return vm.newNumber(id);
  }

  function fire(id: number): void {
    const entry = scheduled.get(id);
    if (!entry) {
      return;
    }
    if (entry.periodMs === null) {
      scheduled.delete(id);
      invoke(entry.callback, 'timer callback');
      return;
    }
    scheduled.set(id, { ...entry, handle: timers.setTimeout(() => fire(id), entry.periodMs) });
    // A handle of its own, so an interval that clears itself in its callback cannot free the function while it runs.
    invoke(entry.callback.dup(), 'timer callback');
  }

  function clear(id: QuickJSHandle | undefined): void {
    const key: unknown = id ? vm.dump(id) : null;
    if (typeof key !== 'number') {
      return;
    }
    const entry = scheduled.get(key);
    if (!entry) {
      return;
    }
    scheduled.delete(key);
    timers.clearTimeout(entry.handle);
    entry.callback.dispose();
  }

  function queue(callback: QuickJSHandle | undefined): void {
    assertFunction(callback, 'queueMicrotask');
    if (microtasks.size >= MAX_PENDING_MICROTASKS) {
      // Once a burst, so a module stuck in a loop cannot flood the reports either.
      if (!microtaskCapReported) {
        microtaskCapReported = true;
        onError(
          new Error(`The VM queued more than ${String(MAX_PENDING_MICROTASKS)} microtasks, so some were dropped`),
        );
      }
      return;
    }
    microtaskCapReported = false;
    const held = callback.dup();
    microtasks.add(held);
    queueMicrotask(() => {
      // Dispose drops the microtask and frees its handle.
      if (microtasks.delete(held)) {
        invoke(held, 'microtask');
      }
    });
  }

  /** Calls `callback` with the global object as `this`, frees it, then runs the jobs it queued. */
  function invoke(callback: QuickJSHandle, what: string): void {
    const result = vm.callFunction(callback, vm.global);
    callback.dispose();
    if (result.error) {
      const message = getVmErrorMessage(vm.dump(result.error));
      result.error.dispose();
      onError(new Error(`A ${what} in the VM threw: ${message}`));
    } else {
      result.value.dispose();
    }
    // `onError` may have disposed the VM.
    if (!disposed) {
      runVmJobs(vm, onError, `a ${what}`);
    }
  }

  function assertFunction(callback: QuickJSHandle | undefined, name: string): asserts callback is QuickJSHandle {
    if (!callback || vm.typeof(callback) !== 'function') {
      throw new TypeError(`${name} takes a function`);
    }
  }
}
