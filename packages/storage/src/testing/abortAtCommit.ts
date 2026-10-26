// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A commit the browser refuses after the writes themselves succeeded, the shape a full quota takes. The fake database
// cannot run out of space, so the transaction is aborted once its first write succeeds.

/** Calls `onWrite` after each write request on `store` succeeds. */
function watchWrites(store: IDBObjectStore, onWrite: () => void): void {
  const add = store.add.bind(store);
  const put = store.put.bind(store);
  const remove = store.delete.bind(store);
  const clear = store.clear.bind(store);
  const watch = <T>(request: IDBRequest<T>): IDBRequest<T> => {
    request.addEventListener('success', onWrite);
    return request;
  };
  store.add = (...args: Parameters<IDBObjectStore['add']>) => watch(add(...args));
  store.put = (...args: Parameters<IDBObjectStore['put']>) => watch(put(...args));
  store.delete = (...args: Parameters<IDBObjectStore['delete']>) => watch(remove(...args));
  store.clear = () => watch(clear());
}

/** For `memoryIdb({ onTransaction })`: every readwrite transaction aborts once its first write succeeds. */
export function abortAtCommit(tx: IDBTransaction): void {
  if (tx.mode !== 'readwrite') {
    return;
  }
  let aborted = false;
  const abort = (): void => {
    if (!aborted) {
      aborted = true;
      tx.abort();
    }
  };
  // A transaction hands out the same store object for a name each time, so it is wrapped once.
  const watched = new WeakSet<IDBObjectStore>();
  const objectStore = tx.objectStore.bind(tx);
  tx.objectStore = (name: string): IDBObjectStore => {
    const store = objectStore(name);
    if (!watched.has(store)) {
      watched.add(store);
      watchWrites(store, abort);
    }
    return store;
  };
}
