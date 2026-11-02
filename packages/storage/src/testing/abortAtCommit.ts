// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A commit the browser refuses after the writes themselves succeeded, the shape a full quota takes. The fake database
// cannot run out of space, so the transaction is aborted once its first write succeeds.

/** For `createMemoryIdb({ onTransaction })`: every readwrite transaction aborts once its first write succeeds. */
export function abortAtCommit(transaction: IDBTransaction): void {
  if (transaction.mode !== 'readwrite') {
    return;
  }
  let aborted = false;
  function abort(): void {
    if (!aborted) {
      aborted = true;
      transaction.abort();
    }
  }
  // A transaction hands out the same store object for a name each time, so it is wrapped once.
  const watched = new WeakSet<IDBObjectStore>();
  const objectStore = transaction.objectStore.bind(transaction);
  transaction.objectStore = (name: string): IDBObjectStore => {
    const store = objectStore(name);
    if (!watched.has(store)) {
      watched.add(store);
      watchWrites(store, abort);
    }
    return store;
  };
}

/** Calls `onWrite` after each write request on `store` succeeds. */
function watchWrites(store: IDBObjectStore, onWrite: () => void): void {
  const add = store.add.bind(store);
  const put = store.put.bind(store);
  const remove = store.delete.bind(store);
  const clear = store.clear.bind(store);
  function watchRequest<Result>(request: IDBRequest<Result>): IDBRequest<Result> {
    request.addEventListener('success', onWrite);
    return request;
  }
  store.add = (...args: Parameters<IDBObjectStore['add']>) => watchRequest(add(...args));
  store.put = (...args: Parameters<IDBObjectStore['put']>) => watchRequest(put(...args));
  store.delete = (...args: Parameters<IDBObjectStore['delete']>) => watchRequest(remove(...args));
  store.clear = () => watchRequest(clear());
}
