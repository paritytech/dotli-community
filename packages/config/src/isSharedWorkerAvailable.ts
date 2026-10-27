// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The global to look in. The page's global by default. */
  scope?: { SharedWorker?: unknown };
};

/** Whether `scope` can start a SharedWorker. */
export function isSharedWorkerAvailable({ scope = globalThis }: Params = {}): boolean {
  return typeof scope.SharedWorker !== 'undefined';
}
