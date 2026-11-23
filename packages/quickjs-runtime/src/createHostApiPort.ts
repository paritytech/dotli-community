// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The VM's `__HOST_API_PORT__`, a MessagePort-like object that carries bytes, and the host's end of it, the wire.

import { createListenerSet } from '@dotli/shared';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';

import type { VmBytes } from './createVmBytes.js';
import { defineVmFunctions } from './defineVmFunctions.js';
import { getVmErrorMessage } from './getVmErrorMessage.js';
import { runVmJobs } from './runVmJobs.js';

type Params = {
  vm: QuickJSContext;
  bytes: VmBytes;
  /** Hears what went wrong on the port: a listener in either side that threw, or a frame that is not bytes. */
  onError: (error: Error) => void;
};

/** The host's end of the port, which carries one `Uint8Array` per frame. */
export type ByteWire = ReturnType<typeof createHostApiPort>['wire'];

// Each listener pins a function in the VM, so code that adds a fresh closure in a loop would fill the VM's heap.
const MAX_MESSAGE_LISTENERS = 32;

/**
 * Sets `__HOST_API_PORT__` on the VM's global object and returns the wire to it.
 *
 * Throws when the VM cannot build the port.
 */
export function createHostApiPort({ vm, bytes, onError }: Params) {
  const frames = createListenerSet<Uint8Array>({
    onListenerError: error => onError(new Error('A wire listener threw on a frame from the VM', { cause: error })),
  });
  // A VM value gets a new handle on each `dup()`, so only the VM's own `===` tells two handles of one function apart.
  const isSame = vm.unwrapResult(vm.evalCode('(a, b) => a === b'));
  const listeners: QuickJSHandle[] = [];
  let onMessage: QuickJSHandle | null = null;
  let closed = false;

  installPort();

  return {
    wire: {
      /** Delivers `bytes` to the port's listeners, then runs the jobs they queued. Ignored once the port closes. */
      postMessage: deliver,
      /** Hears each frame the VM posts. */
      subscribe: frames.subscribe,
    },
    /** Closes the port and frees what it holds in the VM. Safe to call again. */
    dispose() {
      close();
      if (isSame.alive) {
        isSame.dispose();
      }
    },
  };

  function installPort(): void {
    const port = vm.newObject();
    defineVmFunctions(vm, port, {
      postMessage(data) {
        if (closed) {
          return;
        }
        try {
          frames.emit(bytes.fromVm(data));
        } catch (error) {
          onError(new Error('The VM posted a frame that is not bytes', { cause: error }));
        }
      },
      addEventListener(type, listener) {
        if (closed || vm.getString(type) !== 'message' || vm.typeof(listener) !== 'function') {
          return;
        }
        if (listeners.some(added => isSameValue(added, listener))) {
          return;
        }
        // Dropped rather than thrown, since a DOM port never throws from `addEventListener`.
        if (listeners.length >= MAX_MESSAGE_LISTENERS) {
          onError(new Error(`The VM added more than ${String(MAX_MESSAGE_LISTENERS)} message listeners`));
          return;
        }
        listeners.push(listener.dup());
      },
      removeEventListener(type, listener) {
        if (vm.getString(type) !== 'message') {
          return;
        }
        const index = listeners.findIndex(added => isSameValue(added, listener));
        if (index !== -1) {
          listeners.splice(index, 1)[0]?.dispose();
        }
      },
      start: () => undefined,
      close,
    });
    vm.defineProp(port, 'onmessage', {
      configurable: false,
      enumerable: true,
      get: () => onMessage?.dup() ?? vm.null,
      set(listener: QuickJSHandle) {
        onMessage?.dispose();
        onMessage = !closed && vm.typeof(listener) === 'function' ? listener.dup() : null;
      },
    });
    vm.setProp(vm.global, '__HOST_API_PORT__', port);
    port.dispose();
  }

  function deliver(frame: Uint8Array): void {
    if (closed) {
      return;
    }
    const event = vm.newObject();
    const data = bytes.toVm(frame);
    vm.setProp(event, 'data', data);
    data.dispose();
    for (const listener of onMessage ? [onMessage, ...listeners] : [...listeners]) {
      // A listener before it may have removed it or closed the port, which frees its handle.
      if (!listener.alive) {
        continue;
      }
      const result = vm.callFunction(listener, vm.undefined, event);
      if (result.error) {
        onError(new Error(`A message listener in the VM threw: ${getVmErrorMessage(vm.dump(result.error))}`));
        result.error.dispose();
      } else {
        result.value.dispose();
      }
    }
    event.dispose();
    runVmJobs(vm, onError, 'a message');
  }

  function close(): void {
    closed = true;
    onMessage?.dispose();
    onMessage = null;
    for (const listener of listeners.splice(0)) {
      listener.dispose();
    }
  }

  function isSameValue(a: QuickJSHandle, b: QuickJSHandle): boolean {
    const result = vm.callFunction(isSame, vm.undefined, a, b);
    const same = vm.unwrapResult(result);
    const value = vm.dump(same) === true;
    same.dispose();
    return value;
  }
}
