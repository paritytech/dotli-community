// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Timers } from '@dotli/shared';
import { realTimers } from '@dotli/shared';
import releaseAsyncify from '@jitl/quickjs-wasmfile-release-asyncify';
import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten-core';
import { newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten-core';

import { createHostApiPort } from './createHostApiPort.js';
import type { ModuleFiles } from './createModuleLoader.js';
import { createModuleLoader } from './createModuleLoader.js';
import type { VmBytes } from './createVmBytes.js';
import { createVmBytes } from './createVmBytes.js';
import { createVmCrypto } from './createVmCrypto.js';
import { createVmTimers } from './createVmTimers.js';
import { getVmErrorMessage } from './getVmErrorMessage.js';
import type { ConsoleSink } from './installConsole.js';
import { installConsole } from './installConsole.js';
import { installTextCodecs } from './installTextCodecs.js';

export type QuickJsVmParams = {
  /** The module files, by path. Imports resolve against them alone. */
  files: ModuleFiles;
  /** The path in `files` of the ES module that `run` evaluates. */
  entrypoint: string;
  /**
   * Hears what goes wrong in the VM outside a run: a listener or a timer callback that threw, a frame that is not
   * bytes, a job that failed, microtasks dropped past the cap, or a VM that aborted while it was freed.
   */
  onError: (error: Error) => void;
  /** Hears each `console` call of the VM's code. The runtime logs nothing itself. */
  onConsole: ConsoleSink;
  /** The WebCrypto behind the VM's `crypto`. */
  crypto: Crypto;
  /** The host timers behind the VM's timers. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

export type QuickJsVm = Awaited<ReturnType<typeof createQuickJsVm>>;

/**
 * Builds one QuickJS VM, with the host API port and the browser marks a worker script looks for, ready to run its
 * entrypoint. Subscribe to `wire` before `run`, so no frame the module posts as it starts is missed.
 *
 * Rejects when the WebAssembly module fails to load or the VM cannot be set up.
 */
export async function createQuickJsVm({
  files,
  entrypoint,
  onError,
  onConsole,
  crypto,
  timers = realTimers,
}: QuickJsVmParams) {
  // One WebAssembly module per VM, since freeing a VM can abort its module, which must take no other VM with it.
  // The variant's types describe its CommonJS build, whose default export wraps the variant. The loader unwraps either
  // shape, and takes the wrapped one only as a promise.
  const quickJs = await newQuickJSAsyncWASMModuleFromVariant(Promise.resolve(releaseAsyncify));
  const vm = quickJs.newContext();
  const loader = createModuleLoader(files);
  vm.runtime.setModuleLoader(loader.load, loader.normalize);
  const bytes = createVmBytes({ vm });
  const port = createHostApiPort({ vm, bytes, onError });
  const globals = injectGlobals({ vm, bytes, onError, onConsole, crypto, timers });
  let running: Promise<void> | null = null;
  let disposed = false;

  return {
    wire: port.wire,
    /**
     * Evaluates the entrypoint and resolves once the module and its top-level await finish. A repeated call returns
     * the first run.
     *
     * Rejects with the VM's message when the entrypoint is missing, an import is not in the files, the module throws,
     * or its top-level await rejects. Also rejects when the VM is disposed before the module is evaluated, and stays
     * pending when it is disposed during a top-level await.
     */
    run(): Promise<void> {
      running ??= runEntrypoint();
      return running;
    },
    /** Ends the port and frees the VM. Safe to call again. */
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      globals.dispose();
      port.dispose();
      bytes.dispose();
      try {
        vm.runtime.executePendingJobs();
        vm.dispose();
      } catch (error) {
        // Freeing asserts that no VM object is left, which a product's live closures almost always break. The abort
        // ends this VM's own module only, so the VM is abandoned to the host's garbage collector.
        onError(new Error('The QuickJS module aborted while freeing the VM', { cause: error }));
      }
    },
  };

  async function runEntrypoint(): Promise<void> {
    throwIfDisposed();
    const source = loader.load(entrypoint, vm);
    if (typeof source !== 'string') {
      throw new Error(`The entrypoint '${entrypoint}' is not in the files`);
    }
    const evaluated = await vm.evalCodeAsync(source, entrypoint, { type: 'module' });
    // Each await lets the host dispose the VM, after which none of its handles may be touched.
    throwIfDisposed();
    if (evaluated.error) {
      throw toRunError(evaluated.error);
    }
    // The module's value is a promise of its exports when it awaits at the top level, and its exports otherwise.
    const settled = vm.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) {
      throw toRunError(jobs.error);
    }
    const outcome = await settled;
    throwIfDisposed();
    if (outcome.error) {
      throw toRunError(outcome.error);
    }
    outcome.value.dispose();
  }

  function throwIfDisposed(): void {
    if (disposed) {
      throw new Error(`The VM was disposed while running '${entrypoint}'`);
    }
  }

  function toRunError(error: QuickJSHandle): Error {
    const message = getVmErrorMessage(vm.dump(error));
    error.dispose();
    return new Error(`Running '${entrypoint}' failed in the VM: ${message}`);
  }
}

type InjectGlobalsParams = Required<Pick<QuickJsVmParams, 'onError' | 'onConsole' | 'crypto' | 'timers'>> & {
  vm: QuickJSAsyncContext;
  bytes: VmBytes;
};

/** Sets the globals the VM's code reads beside the port, and returns what stops the ones that hold host work. */
function injectGlobals({ vm, bytes, onError, onConsole, crypto, timers }: InjectGlobalsParams) {
  vm.setProp(vm.global, '__HOST_WEBVIEW_MARK__', vm.true);
  // Code that checks for a browser, such as `window === self`, finds one. Neither can be replaced or deleted, so VM
  // code cannot swap in a global of its own.
  vm.unwrapResult(
    vm.evalCode(
      `for (const name of ['top', 'window']) {
        Object.defineProperty(globalThis, name, { value: globalThis, writable: false, configurable: false, enumerable: true });
      }`,
    ),
  ).dispose();
  installConsole(vm, onConsole);
  installTextCodecs(vm, bytes);
  const vmTimers = createVmTimers({ vm, timers, onError });
  const vmCrypto = createVmCrypto({ vm, bytes, crypto, onError });

  return {
    dispose() {
      vmTimers.dispose();
      vmCrypto.dispose();
    },
  };
}
