// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext, QuickJSHandle, VmFunctionImplementation } from 'quickjs-emscripten-core';

/** Host functions by the name they take in the VM. */
export type VmFunctions = Record<string, VmFunctionImplementation<QuickJSHandle>>;

/**
 * Sets each of `functions` as a VM function on `target`, under its key. A host function that throws throws its `name`
 * and `message` in the VM.
 *
 * Throws when the VM cannot build a function or set it.
 */
export function defineVmFunctions(vm: QuickJSContext, target: QuickJSHandle, functions: VmFunctions): void {
  for (const [name, implementation] of Object.entries(functions)) {
    const handle = vm.newFunction(name, implementation);
    vm.setProp(target, name, handle);
    handle.dispose();
  }
}
