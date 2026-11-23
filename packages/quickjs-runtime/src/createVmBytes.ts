// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Copies bytes across the VM boundary in both directions. A copy, never a shared buffer, so neither side can change
// what the other holds.

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';

type Params = {
  vm: QuickJSContext;
};

export type VmBytes = ReturnType<typeof createVmBytes>;

/**
 * Moves bytes into and out of one VM.
 *
 * Throws when the VM cannot build its helper.
 */
export function createVmBytes({ vm }: Params) {
  // Binds the constructor now, so VM code that later replaces the global `Uint8Array` cannot change what this builds.
  const toUint8Array = vm.unwrapResult(vm.evalCode('(Bytes => buffer => new Bytes(buffer))(Uint8Array)'));

  return {
    /**
     * A new `Uint8Array` inside the VM holding a copy of `bytes`. The caller disposes the handle.
     *
     * Throws when the VM cannot build it.
     */
    toVm(bytes: Uint8Array): QuickJSHandle {
      const buffer = vm.newArrayBuffer(bytes.slice().buffer);
      const result = vm.callFunction(toUint8Array, vm.undefined, buffer);
      buffer.dispose();
      return vm.unwrapResult(result);
    },
    /**
     * A copy of the bytes a typed array in the VM views, which stays valid after the VM frees it.
     *
     * Throws when the handle is not a typed array.
     */
    fromVm(view: QuickJSHandle): Uint8Array {
      const offset = readNumber(vm, view, 'byteOffset');
      const length = readNumber(vm, view, 'byteLength');
      const buffer = vm.getProp(view, 'buffer');
      try {
        const lifetime = vm.getArrayBuffer(buffer);
        const copy = lifetime.value.slice(offset, offset + length);
        lifetime.dispose();
        return copy;
      } finally {
        buffer.dispose();
      }
    },
    dispose() {
      toUint8Array.dispose();
    },
  };
}

function readNumber(vm: QuickJSContext, target: QuickJSHandle, key: string): number {
  const handle = vm.getProp(target, key);
  const value = vm.getNumber(handle);
  handle.dispose();
  return value;
}
