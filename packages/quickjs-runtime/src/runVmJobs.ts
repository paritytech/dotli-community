// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext } from 'quickjs-emscripten-core';

import { getVmErrorMessage } from './getVmErrorMessage.js';

/**
 * Runs the promise jobs the VM has queued, and tells `onError` of a job that threw, naming what came before it, such
 * as "a message". The error's handle is freed before `onError` hears it, so `onError` may dispose the VM.
 */
export function runVmJobs(vm: QuickJSContext, onError: (error: Error) => void, after: string): void {
  const jobs = vm.runtime.executePendingJobs();
  if (!jobs.error) {
    return;
  }
  const message = getVmErrorMessage(vm.dump(jobs.error));
  jobs.error.dispose();
  onError(new Error(`A job after ${after} failed in the VM: ${message}`));
}
