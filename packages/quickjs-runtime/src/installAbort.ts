// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext } from 'quickjs-emscripten-core';

import { runVmInstaller } from './runVmInstaller.js';

// Evaluated by the VM, not by the browser, so it stays a string. The globals it builds on are
// bound when it runs, so VM code that later replaces one cannot change how a signal aborts.
const INSTALLER_SOURCE = `() => {
  const BaseEventTarget = EventTarget;
  const BaseEvent = Event;
  const BaseDOMException = DOMException;
  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const startTimer = setTimeout;
  // Only this closure holds it, so VM code cannot build a signal no controller owns.
  const construct = Symbol('AbortSignal');
  const signals = new WeakMap();

  function readSignal(signal) {
    const state = signals.get(signal);
    if (!state) {
      throw new TypeError('Illegal invocation');
    }
    return state;
  }

  function signalAbort(signal, reason) {
    const state = readSignal(signal);
    if (state.aborted) {
      return;
    }
    state.aborted = true;
    state.reason = reason === undefined ? new BaseDOMException('signal is aborted without reason', 'AbortError') : reason;
    dispatch.call(signal, new BaseEvent('abort'));
  }

  class AbortSignal extends BaseEventTarget {
    constructor(token) {
      if (token !== construct) {
        throw new TypeError('Illegal constructor');
      }
      super();
      const state = { aborted: false, reason: undefined, onabort: null };
      signals.set(this, state);
      // The handler is a listener added first, so it runs before every listener added later.
      addListener.call(this, 'abort', event => state.onabort?.call(this, event));
    }
    get aborted() {
      return readSignal(this).aborted;
    }
    get reason() {
      return readSignal(this).reason;
    }
    get onabort() {
      return readSignal(this).onabort;
    }
    set onabort(handler) {
      readSignal(this).onabort = typeof handler === 'function' ? handler : null;
    }
    throwIfAborted() {
      const state = readSignal(this);
      if (state.aborted) {
        throw state.reason;
      }
    }
    static abort(reason) {
      const signal = new AbortSignal(construct);
      signalAbort(signal, reason);
      return signal;
    }
    static timeout(milliseconds) {
      const delay = Number(milliseconds);
      if (!Number.isFinite(delay) || delay < 0) {
        throw new TypeError('AbortSignal.timeout takes a non-negative finite number of milliseconds');
      }
      const signal = new AbortSignal(construct);
      startTimer(() => signalAbort(signal, new BaseDOMException('The operation timed out.', 'TimeoutError')), delay);
      return signal;
    }
    static any(sources) {
      const list = [...sources];
      if (!list.every(source => signals.has(source))) {
        throw new TypeError('AbortSignal.any takes AbortSignals only');
      }
      const signal = new AbortSignal(construct);
      const aborted = list.find(source => readSignal(source).aborted);
      if (aborted) {
        signalAbort(signal, readSignal(aborted).reason);
        return signal;
      }
      function follow(event) {
        // The first source to abort detaches from the others, so they no longer hold the signal.
        for (const source of list) {
          removeListener.call(source, 'abort', follow);
        }
        signalAbort(signal, readSignal(event.currentTarget).reason);
      }
      for (const source of list) {
        addListener.call(source, 'abort', follow, { once: true });
      }
      return signal;
    }
  }
  Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });

  class AbortController {
    #signal = new AbortSignal(construct);
    get signal() {
      return this.#signal;
    }
    abort(reason) {
      signalAbort(this.#signal, reason);
    }
  }
  Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });

  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;
}`;

/**
 * Sets the VM's `AbortController` and `AbortSignal`, with `AbortSignal.abort`, `timeout` and `any`. A signal aborted with
 * no reason takes an `AbortError` `DOMException`, and a timeout a `TimeoutError` one.
 *
 * Throws when the VM cannot install them, or when the events and timers are not installed first.
 */
export function installAbort(vm: QuickJSContext): void {
  runVmInstaller(vm, INSTALLER_SOURCE, {});
}
