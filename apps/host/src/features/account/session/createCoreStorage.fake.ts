// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SharedStoreStatus } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';
import { atom } from 'nanostores';
import type { HostCoreStorage, SessionRead, SharedSessionStore } from './createCoreStorage.js';

/** An in-memory shared auth store with the protocol frame's failure modes. */
export type FakeSharedSessionStore = {
  /** What the store holds, by key. */
  readonly entries: Map<string, string>;
  /** Every key read, in order. */
  readonly reads: string[];
  /** While set, every read rejects with it. */
  readError: Error | null;
  /** While set, reads wait on it, so a test can hold one in flight. */
  readGate: Promise<void> | null;
  /** Every write, in order, whether or not it changed the value. */
  readonly writes: [key: string, value: string][];
  /** Every key cleared, in order. */
  readonly clears: string[];
  /** While set, every write rejects with it. */
  writeError: Error | null;
  /** Answers the error a clear of `key` rejects with, or null to clear it. */
  clearError: ((key: string) => Error | null) | null;
  /** Resolves with the value of the next write of `key`. Rejects at once while writes fail. */
  nextWrite(key: string): Promise<string>;
  /** Resolves once `key` is next cleared. Rejects at once while its clear fails, and when that clear fails. */
  nextClear(key: string): Promise<void>;
  /** The store reporting a status change, as the protocol client does. */
  setStatus(status: SharedStoreStatus): void;
  /** Another tab writing a key. */
  changeFromOtherTab(key: string, value: string): void;
  /** How many status listeners are subscribed. */
  statusListenerCount(): number;
} & SharedSessionStore;

/** The page's copy as a login waits on it: a session a core stores, a write of it that fails, or reads that fail. */
export type FakeStoredSession = {
  /** A core storing `blob`, which tells every listener and lets reads answer again. */
  store(blob: string): void;
  /** A core's write of its session failing. */
  failWrite(error: Error): void;
  /** Every read answering failed with `error` until the next `store`. */
  failReads(error: unknown): void;
} & Pick<HostCoreStorage, 'readSession' | 'subscribeStoredSession' | 'subscribeSessionWriteFailures'>;

type CreateFakeSharedSessionStoreParams = {
  /** The status the store starts at, connecting by default. */
  status?: SharedStoreStatus;
};

type CreateFakeStoredSessionParams = {
  /** The session the copy holds at first, none by default. */
  blob?: string | null;
};

/** A shared auth store in memory, starting at `status`. Rejects only as a test stages it. */
export function createFakeSharedSessionStore({
  status = 'connecting',
}: CreateFakeSharedSessionStoreParams = {}): FakeSharedSessionStore {
  const entries = new Map<string, string>();
  const writeWaiters = new Map<string, ((value: string) => void)[]>();
  const clearWaiters = new Map<string, ReturnType<typeof createDeferred<undefined>>[]>();
  const changeListeners = new Set<(key: string) => void>();
  const current = atom(status);
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
      const changed = entries.get(key) !== value;
      entries.set(key, value);
      for (const resolve of writeWaiters.get(key)?.splice(0) ?? []) {
        resolve(value);
      }
      return Promise.resolve(changed);
    },
    clear(key) {
      const error = store.clearError?.(key) ?? null;
      const waiters = clearWaiters.get(key)?.splice(0) ?? [];
      if (error !== null) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
        return Promise.reject(error);
      }
      store.clears.push(key);
      entries.delete(key);
      for (const waiter of waiters) {
        waiter.resolve(undefined);
      }
      return Promise.resolve();
    },
    clearIf(key, expected) {
      if (entries.get(key) !== expected) {
        return Promise.resolve(false);
      }
      return store.clear(key).then(() => true);
    },
    nextWrite(key) {
      if (store.writeError !== null) {
        return Promise.reject(store.writeError);
      }
      return new Promise(resolve => {
        writeWaiters.set(key, [...(writeWaiters.get(key) ?? []), resolve]);
      });
    },
    nextClear(key) {
      const error = store.clearError?.(key) ?? null;
      if (error !== null) {
        return Promise.reject(error);
      }
      const waiter = createDeferred<undefined>();
      clearWaiters.set(key, [...(clearWaiters.get(key) ?? []), waiter]);
      return waiter.promise;
    },
    subscribe(listener) {
      function handleChange(key: string): void {
        listener(key);
      }
      changeListeners.add(handleChange);
      return unsubscribe;

      function unsubscribe(): void {
        changeListeners.delete(handleChange);
      }
    },
    getStatusStore: () => current,
    setStatus(next) {
      current.set(next);
    },
    changeFromOtherTab(key, value) {
      entries.set(key, value);
      for (const listener of [...changeListeners]) {
        listener(key);
      }
    },
    statusListenerCount: () => current.lc,
  };
  return store;
}

/** The page's copy holding `blob`. Never rejects. */
export function createFakeStoredSession({ blob = null }: CreateFakeStoredSessionParams = {}): FakeStoredSession {
  let stored = blob;
  let failedRead: SessionRead | null = null;
  const changes = new Set<() => void>();
  const failures = new Set<(error: unknown) => void>();
  return {
    readSession: () => Promise.resolve(failedRead ?? { status: 'ok', blob: stored }),
    subscribeStoredSession(listener) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    subscribeSessionWriteFailures(listener) {
      failures.add(listener);
      return () => failures.delete(listener);
    },
    store(next) {
      stored = next;
      failedRead = null;
      for (const listener of [...changes]) {
        listener();
      }
    },
    failWrite(error) {
      for (const listener of [...failures]) {
        listener(error);
      }
    },
    failReads(error) {
      failedRead = { status: 'failed', error };
    },
  };
}
