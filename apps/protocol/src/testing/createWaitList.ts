// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Waiter = {
  isDone: () => boolean;
  resolve: () => void;
};

/** Waits that each settle once their condition holds, as the owner of that condition checks them after each change. */
export function createWaitList() {
  const waiters: Waiter[] = [];

  return {
    /** Resolves once `isDone` holds, at once when it already does. Never rejects. Throws what `isDone` throws. */
    waitFor,
    /** Settles every wait whose condition holds now. Throws what a condition throws. */
    check,
  };

  function waitFor(isDone: () => boolean): Promise<void> {
    if (isDone()) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      waiters.push({ isDone, resolve });
    });
  }

  function check(): void {
    for (const waiter of [...waiters]) {
      if (waiter.isDone()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }
}
