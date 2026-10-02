// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Network } from '@dotli/config';

/**
 * One worker identity per network across every tab on the shared host origin.
 * Passing the retired identity advances it only if it is still current: a
 * second tab's fatal, or a late callback, must not replace the new worker.
 */
export async function sharedWorkerGeneration(network: Network, retired?: string): Promise<string> {
  if (typeof navigator.locks === 'undefined') {
    throw new Error('Shared light clients require secure-context Web Locks');
  }
  const key = `dotli:protocol-worker-generation:${network}`;
  return navigator.locks.request(key, () => {
    const current = localStorage.getItem(key) ?? '0';
    if (current !== retired) {
      return current;
    }
    const next = crypto.randomUUID();
    localStorage.setItem(key, next);
    return next;
  });
}
