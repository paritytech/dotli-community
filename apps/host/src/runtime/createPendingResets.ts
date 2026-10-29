// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Purge requests that survive the reload a reset ends with. The host cannot wipe the protocol and sandbox origins, so
// it asks each of them to purge itself on the next boot.

import { reportExpected, spans as S } from '@dotli/metrics';

export type PendingResetTarget = 'protocol' | 'sandbox';

export type ResetStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type Params = {
  /** The storage the requests live in, read on each call. Throws when the storage cannot be reached. */
  storage: () => ResetStorage;
  /** Hears each storage that could not be read. Must not throw. */
  onReadFailure: (error: unknown) => void;
};

/** Builds the pending resets over `storage`. Building it never throws. */
export function createPendingResets({ storage, onReadFailure }: Params) {
  function schedule(targets: readonly PendingResetTarget[]): void {
    try {
      const store = storage();
      for (const target of targets) {
        store.setItem(getResetKey(target), '1');
      }
    } catch (cause: unknown) {
      throw new Error('Pending reset not scheduled', { cause });
    }
  }

  function take(target: PendingResetTarget): boolean {
    try {
      const store = storage();
      if (store.getItem(getResetKey(target)) !== '1') {
        return false;
      }
      store.removeItem(getResetKey(target));
      return true;
    } catch (error: unknown) {
      onReadFailure(error);
      return false;
    }
  }

  return {
    /**
     * Asks the origins to purge on the next boot. Throws when the request cannot be stored, so the reset reports it.
     */
    schedule,
    /**
     * Whether a purge was asked for, clearing the request so later navigations do not purge again. A storage that
     * cannot be read answers false, as no request could have been stored. Never throws.
     */
    take,
  };
}

/** The page's pending resets, kept in its session storage. */
export const pendingResets = createPendingResets({
  storage: () => sessionStorage,
  onReadFailure: error => {
    // No session storage, as in a private window, is the browser's limit rather than a fault.
    reportExpected(error, { flow: 'storage', step: 'pending_reset', metric: S.PENDING_RESET_READ });
  },
});

function getResetKey(target: PendingResetTarget): string {
  return `dotli:pending-reset:${target}`;
}
