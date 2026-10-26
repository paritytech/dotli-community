// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The request's result once it succeeds. */
export function waitForIdbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(describeFailure(request)));
    };
  });
}

function describeFailure(request: IDBRequest): string {
  // An open or delete request has a transaction only while it upgrades, so any other has no database to name.
  const name = request.transaction?.db.name;
  return name === undefined ? 'IndexedDB request failed' : `IndexedDB request failed in ${name} DB`;
}
