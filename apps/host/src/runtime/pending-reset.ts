// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Purge requests that survive the reload a reset ends with. The host cannot wipe the protocol and sandbox origins, so
// it asks each of them to purge itself on the next boot.

import { reportExpected, spans as S } from '@dotli/metrics';

export type PendingResetTarget = 'protocol' | 'sandbox';

export type ResetStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PendingResets {
  /** Asks the origins to purge on the next boot. Throws when the request cannot be stored, so the reset reports it. */
  schedule(targets: readonly PendingResetTarget[]): void;
  /**
   * Whether a purge was asked for, clearing the request so later navigations do not purge again. A storage that cannot
   * be read answers false, as no request could have been stored.
   */
  take(target: PendingResetTarget): boolean;
}

export function createPendingResets(storage: () => ResetStorage, onReadFailure: (err: unknown) => void): PendingResets {
  const keyOf = (target: PendingResetTarget): string => `dotli:pending-reset:${target}`;
  return {
    schedule(targets) {
      try {
        const store = storage();
        for (const target of targets) {
          store.setItem(keyOf(target), '1');
        }
      } catch (cause: unknown) {
        throw new Error('Pending reset not scheduled', { cause });
      }
    },
    take(target) {
      try {
        const store = storage();
        if (store.getItem(keyOf(target)) !== '1') {
          return false;
        }
        store.removeItem(keyOf(target));
        return true;
      } catch (err: unknown) {
        onReadFailure(err);
        return false;
      }
    },
  };
}

const pendingResets = createPendingResets(
  () => sessionStorage,
  err => {
    // No session storage, as in a private window, is the browser's limit rather than a fault.
    reportExpected(err, { flow: 'storage', step: 'pending_reset', metric: S.PENDING_RESET_READ });
  },
);

export function schedulePendingReset(targets: readonly PendingResetTarget[]): void {
  pendingResets.schedule(targets);
}

export function takePendingReset(target: PendingResetTarget): boolean {
  return pendingResets.take(target);
}
