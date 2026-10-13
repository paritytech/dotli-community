// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// IndexedDB's callbacks as promises, for every store on dotli's databases.

/** Opens `name` at `version`, rejecting rather than hanging when an older tab blocks the upgrade. */
export function openIdb(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = () => {
      upgrade(req.result);
    };
    // The caller already got the blocked rejection, so a late success has no owner and must not stay open.
    let abandoned = false;
    req.onsuccess = () => {
      if (abandoned) {
        req.result.close();
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => {
      // Only the cause keeps the DOMException's message for the report.
      const cause = req.error;
      reject(new Error(`Failed to open ${name} DB: ${cause?.name ?? 'unknown'}`, cause ? { cause } : undefined));
    };
    // A tab on an older schema blocks the upgrade, and blocked fires neither onsuccess nor onerror.
    req.onblocked = () => {
      abandoned = true;
      reject(new Error(`Failed to open ${name} DB: blocked by another tab`));
    };
  });
}

/** The request's result once it succeeds. */
export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/**
 * Runs `body` in one transaction and resolves once it commits, so a reload right after never loses a write. A body that
 * reads keeps what it read in its own variables. Opening the transaction on a closing connection rejects, and so does a
 * body that throws, which also aborts the transaction.
 */
export function idbTransaction(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => {
      resolve();
    };
    // A failing request bubbles `error` before the transaction aborts, so `tx.error` is still null and the request
    // carries the cause. An abort from outside, such as a forced close, sets `tx.error` first and then fails each
    // pending request with an `AbortError`, so there `tx.error` is the cause.
    tx.onerror = event => {
      const failed = event.target as { error?: DOMException | null } | null;
      reject(tx.error ?? failed?.error ?? new Error('IndexedDB transaction failed'));
    };
    // A commit-time abort, such as a full quota, fires only `abort`.
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
    try {
      body(tx);
    } catch (err) {
      // Rejecting before the abort keeps the body's error even when the body had already aborted and `abort` throws.
      reject(err instanceof Error ? err : new Error('IndexedDB transaction body threw', { cause: err }));
      // Requests the body issued before it threw must not commit.
      tx.abort();
    }
  });
}
