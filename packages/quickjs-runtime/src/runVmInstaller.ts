// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext } from 'quickjs-emscripten-core';

import type { VmFunctions } from './defineVmFunctions.js';
import { defineVmFunctions } from './defineVmFunctions.js';

/**
 * Evaluates `source`, a VM function that sets globals, and calls it with one object of `functions`. The host functions
 * reach only the installer's closure, never a global the VM's code could call.
 *
 * Throws when the source does not evaluate or the installer throws.
 */
export function runVmInstaller(vm: QuickJSContext, source: string, functions: VmFunctions): void {
  const install = vm.unwrapResult(vm.evalCode(source));
  const host = vm.newObject();
  try {
    defineVmFunctions(vm, host, functions);
    vm.unwrapResult(vm.callFunction(install, vm.undefined, host)).dispose();
  } finally {
    host.dispose();
    install.dispose();
  }
}
