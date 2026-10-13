// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `api.whenReady()` never settles without reachable peers, so callers race a timer that names the cause.

import { NetworkSyncTimeoutError } from './errors.js';

export function raceSyncTimeout<T>(work: Promise<T>, chain: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new NetworkSyncTimeoutError(chain, timeoutMs));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}
