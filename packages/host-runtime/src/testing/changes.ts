// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The notice fakes give whenever something a test may wait on changed, so a test checks again then rather than on a
// timer.

export interface Changes {
  /** Wakes every waiter to check again. */
  notify: () => void;
  /** Resolves once `met` holds, checked now and at each notice. */
  until: (met: () => boolean) => Promise<void>;
}

export function createChanges(): Changes {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const check of [...waiters]) {
        check();
      }
    },
    until: met =>
      new Promise(resolve => {
        const check = (): void => {
          if (met()) {
            waiters.delete(check);
            resolve();
          }
        };
        waiters.add(check);
        check();
      }),
  };
}
