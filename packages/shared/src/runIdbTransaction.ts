// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  db: IDBDatabase;
  stores: string | string[];
  mode: IDBTransactionMode;
  body: (transaction: IDBTransaction) => void;
};

/**
 * Runs `body` in one transaction and resolves once it commits, so a reload right after never loses a write. A body that
 * reads keeps what it read in its own variables. Opening the transaction on a closing connection rejects, and so does a
 * body that throws, which also aborts the transaction.
 *
 * @example
 * await runIdbTransaction({ db, stores: 'items', mode: 'readwrite',
 *   body: transaction => transaction.objectStore('items').put(value, key) });
 */
export function runIdbTransaction({ db, stores, mode, body }: Params): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const place = describePlace(db, stores);
    transaction.oncomplete = () => {
      resolve();
    };
    // A failing request bubbles `error` before the transaction aborts, so `transaction.error` is still null and the
    // request carries the cause. An abort from outside, such as a forced close, sets `transaction.error` first and then
    // fails each pending request with an `AbortError`, so there `transaction.error` is the cause.
    transaction.onerror = event => {
      // The target of a bubbled `error` is the request that failed, which the DOM types only as an EventTarget.
      const failed = event.target as { error?: DOMException | null } | null;
      reject(transaction.error ?? failed?.error ?? new Error(`IndexedDB transaction failed ${place}`));
    };
    // A commit-time abort, such as a full quota, fires only `abort`.
    transaction.onabort = () => {
      reject(transaction.error ?? new Error(`IndexedDB transaction aborted ${place}`));
    };
    try {
      body(transaction);
    } catch (error) {
      // Rejecting before the abort keeps the body's error even when the body had already aborted and `abort` throws.
      reject(error instanceof Error ? error : new Error(`IndexedDB transaction body threw ${place}`, { cause: error }));
      // Requests the body issued before it threw must not commit.
      transaction.abort();
    }
  });
}

function describePlace(db: IDBDatabase, stores: string | string[]): string {
  const names = typeof stores === 'string' ? stores : stores.join(', ');
  return `on ${names} in ${db.name} DB`;
}
