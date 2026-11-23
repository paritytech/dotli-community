// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext } from 'quickjs-emscripten-core';

import { runVmInstaller } from './runVmInstaller.js';

// Evaluated by the VM, not by the browser, so it stays a string
// (docs/decisions/source-an-embedded-interpreter-evaluates.md). An event target has one phase, at the target, since the VM has no tree for an event to travel.
const INSTALLER_SOURCE = `() => {
  const exceptionCodes = new Map([
    ['IndexSizeError', 1], ['HierarchyRequestError', 3], ['WrongDocumentError', 4], ['InvalidCharacterError', 5],
    ['NoModificationAllowedError', 7], ['NotFoundError', 8], ['NotSupportedError', 9], ['InUseAttributeError', 10],
    ['InvalidStateError', 11], ['SyntaxError', 12], ['InvalidModificationError', 13], ['NamespaceError', 14],
    ['InvalidAccessError', 15], ['TypeMismatchError', 17], ['SecurityError', 18], ['NetworkError', 19],
    ['AbortError', 20], ['URLMismatchError', 21], ['QuotaExceededError', 22], ['TimeoutError', 23],
    ['InvalidNodeTypeError', 24], ['DataCloneError', 25],
  ]);
  // Bound now, so VM code that later replaces \`console\` cannot hide a listener that threw.
  const reportListenerError = console.error.bind(console);

  class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      super(String(message));
      this.name = String(name);
    }
    get code() {
      return exceptionCodes.get(this.name) ?? 0;
    }
  }
  Object.defineProperty(DOMException.prototype, Symbol.toStringTag, { value: 'DOMException', configurable: true });

  const events = new WeakMap();

  function readEvent(event) {
    const state = events.get(event);
    if (!state) {
      throw new TypeError('Illegal invocation');
    }
    return state;
  }

  class Event {
    constructor(type, init = {}) {
      if (arguments.length === 0) {
        throw new TypeError('An Event needs a type');
      }
      const options = init ?? {};
      events.set(this, {
        type: String(type),
        bubbles: Boolean(options.bubbles),
        cancelable: Boolean(options.cancelable),
        composed: Boolean(options.composed),
        target: null,
        currentTarget: null,
        defaultPrevented: false,
        stopped: false,
        dispatching: false,
      });
    }
    get type() {
      return readEvent(this).type;
    }
    get bubbles() {
      return readEvent(this).bubbles;
    }
    get cancelable() {
      return readEvent(this).cancelable;
    }
    get composed() {
      return readEvent(this).composed;
    }
    get target() {
      return readEvent(this).target;
    }
    get currentTarget() {
      return readEvent(this).currentTarget;
    }
    get eventPhase() {
      return readEvent(this).dispatching ? Event.AT_TARGET : Event.NONE;
    }
    get defaultPrevented() {
      return readEvent(this).defaultPrevented;
    }
    get isTrusted() {
      return false;
    }
    preventDefault() {
      const state = readEvent(this);
      if (state.cancelable) {
        state.defaultPrevented = true;
      }
    }
    stopPropagation() {}
    stopImmediatePropagation() {
      readEvent(this).stopped = true;
    }
  }
  for (const [name, value] of [['NONE', 0], ['CAPTURING_PHASE', 1], ['AT_TARGET', 2], ['BUBBLING_PHASE', 3]]) {
    Object.defineProperty(Event, name, { value, enumerable: true });
  }
  Object.defineProperty(Event.prototype, Symbol.toStringTag, { value: 'Event', configurable: true });

  const targets = new WeakMap();

  function readListeners(target, type) {
    const byType = targets.get(target);
    if (!byType) {
      throw new TypeError('Illegal invocation');
    }
    let listeners = byType.get(type);
    if (!listeners) {
      listeners = [];
      byType.set(type, listeners);
    }
    return listeners;
  }

  function readCapture(options) {
    return typeof options === 'boolean' ? options : Boolean(options?.capture);
  }

  class EventTarget {
    constructor() {
      targets.set(this, new Map());
    }
    addEventListener(type, callback, options) {
      if (callback === null || callback === undefined) {
        return;
      }
      const capture = readCapture(options);
      const once = typeof options === 'object' && options !== null && Boolean(options.once);
      const signal = typeof options === 'object' && options !== null ? options.signal : undefined;
      if (signal?.aborted) {
        return;
      }
      const listeners = readListeners(this, String(type));
      if (listeners.some(entry => entry.callback === callback && entry.capture === capture)) {
        return;
      }
      listeners.push({ callback, capture, once, removed: false });
      signal?.addEventListener('abort', () => this.removeEventListener(type, callback, { capture }), { once: true });
    }
    removeEventListener(type, callback, options) {
      const capture = readCapture(options);
      const listeners = readListeners(this, String(type));
      const index = listeners.findIndex(entry => entry.callback === callback && entry.capture === capture);
      if (index !== -1) {
        listeners[index].removed = true;
        listeners.splice(index, 1);
      }
    }
    dispatchEvent(event) {
      const state = readEvent(event);
      if (state.dispatching) {
        throw new DOMException('The event is already being dispatched', 'InvalidStateError');
      }
      state.dispatching = true;
      state.stopped = false;
      state.target = this;
      state.currentTarget = this;
      for (const entry of [...readListeners(this, state.type)]) {
        if (state.stopped) {
          break;
        }
        if (entry.removed) {
          continue;
        }
        if (entry.once) {
          this.removeEventListener(state.type, entry.callback, { capture: entry.capture });
        }
        // A listener that throws is reported and the rest still run, as in a browser.
        try {
          if (typeof entry.callback === 'function') {
            entry.callback.call(this, event);
          } else if (typeof entry.callback.handleEvent === 'function') {
            entry.callback.handleEvent(event);
          } else {
            throw new TypeError('An event listener is a function or has a handleEvent method');
          }
        } catch (error) {
          reportListenerError(error);
        }
      }
      state.dispatching = false;
      state.currentTarget = null;
      return !state.defaultPrevented;
    }
  }
  Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, { value: 'EventTarget', configurable: true });

  globalThis.DOMException = DOMException;
  globalThis.Event = Event;
  globalThis.EventTarget = EventTarget;
}`;

/**
 * Sets the VM's `DOMException`, `Event` and `EventTarget`. A listener that throws is logged through the VM's
 * `console.error`, and the listeners after it still run.
 *
 * Throws when the VM cannot install them.
 */
export function installEvents(vm: QuickJSContext): void {
  runVmInstaller(vm, INSTALLER_SOURCE, {});
}
