// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The request's result once it succeeds. */
export function waitForIdbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      // A failed request carries its error. The fallback only keeps the rejection an Error for the types.
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}
