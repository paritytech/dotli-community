// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SharedStoreStatus } from '@dotli/protocol';
import type { SharedSessionStore } from './core-storage.js';

/** An in-memory shared auth store with the protocol frame's failure modes. */
export interface FakeSharedSessionStore extends SharedSessionStore {
  readonly entries: Map<string, string>;
  /** Every key read, in order. */
  readonly reads: string[];
  /** While set, every read rejects with it. */
  readError: Error | null;
  /** While set, reads wait on it, so a test can hold one in flight. */
  readGate: Promise<void> | null;
  /** Every write, in order. */
  readonly writes: [key: string, value: string][];
  /** Every key cleared, in order. */
  readonly clears: string[];
  /** While set, every write rejects with it. */
  writeError: Error | null;
  /** Answers the error a clear of `key` rejects with, or null to clear it. */
  clearError: ((key: string) => Error | null) | null;
  /** Resolves with the value of the next write of `key`. */
  nextWrite(key: string): Promise<string>;
  /** The store reporting a status change, as the protocol client does. */
  setStatus(status: SharedStoreStatus): void;
  /** Another tab writing a key. */
  changeFromOtherTab(key: string, value: string): void;
  statusListenerCount(): number;
}

export function createFakeSharedSessionStore(status: SharedStoreStatus = 'connecting'): FakeSharedSessionStore {
  const entries = new Map<string, string>();
  const writeWaiters = new Map<string, ((value: string) => void)[]>();
  const changeListeners = new Set<(key: string) => void>();
  const statusListeners = new Set<(status: SharedStoreStatus) => void>();
  let current = status;
  const store: FakeSharedSessionStore = {
    entries,
    reads: [],
    readError: null,
    readGate: null,
    async read(key) {
      store.reads.push(key);
      await store.readGate;
      if (store.readError !== null) {
        throw store.readError;
      }
      return entries.get(key) ?? null;
    },
    writes: [],
    clears: [],
    writeError: null,
    clearError: null,
    write(key, value) {
      if (store.writeError !== null) {
        return Promise.reject(store.writeError);
      }
      store.writes.push([key, value]);
      entries.set(key, value);
      for (const resolve of writeWaiters.get(key)?.splice(0) ?? []) {
        resolve(value);
      }
      return Promise.resolve();
    },
    clear(key) {
      const error = store.clearError?.(key) ?? null;
      if (error !== null) {
        return Promise.reject(error);
      }
      store.clears.push(key);
      entries.delete(key);
      return Promise.resolve();
    },
    nextWrite(key) {
      if (store.writeError !== null) {
        return Promise.reject(store.writeError);
      }
      return new Promise(resolve => {
        writeWaiters.set(key, [...(writeWaiters.get(key) ?? []), resolve]);
      });
    },
    subscribe(listener) {
      const onChange = (key: string): void => {
        listener(key);
      };
      changeListeners.add(onChange);
      return () => {
        changeListeners.delete(onChange);
      };
    },
    getStatus: () => current,
    subscribeStatus(listener) {
      const onStatus = (next: SharedStoreStatus): void => {
        listener(next);
      };
      statusListeners.add(onStatus);
      return () => {
        statusListeners.delete(onStatus);
      };
    },
    setStatus(next) {
      current = next;
      for (const listener of [...statusListeners]) {
        listener(next);
      }
    },
    changeFromOtherTab(key, value) {
      entries.set(key, value);
      for (const listener of [...changeListeners]) {
        listener(key);
      }
    },
    statusListenerCount: () => statusListeners.size,
  };
  return store;
}
