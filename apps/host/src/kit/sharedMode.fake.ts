// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type MemorySharedChannel = ReturnType<typeof createMemorySharedChannel>;

type Params = {
  /** What the store holds at first, nothing by default. */
  entries?: Record<string, string>;
};

/** The cross-subdomain store as a map, which a test can make unreachable. Building it never throws. */
export function createMemorySharedChannel({ entries = {} }: Params = {}) {
  const store = new Map(Object.entries(entries));
  const writes: [key: string, value: string][] = [];
  const channel = {
    /** What the cross-subdomain store holds. */
    store,
    /** Every write the store was asked for, in order, failed ones included. */
    writes,
    /** Reads reject, as when the storage frame cannot be reached. */
    readFails: false,
    /** Writes reject and leave the store as it was. */
    writeFails: false,
    /** The value under `key`, or null when none is stored. Rejects while `readFails` is set. */
    read,
    /** Records the write and stores `value` under `key`. Rejects while `writeFails` is set. */
    write,
    /** Removes `key`. Never rejects. */
    clear,
  };
  return channel;

  function read(key: string): Promise<string | null> {
    return channel.readFails ? rejectUnreachable() : Promise.resolve(store.get(key) ?? null);
  }

  function write(key: string, value: string): Promise<void> {
    writes.push([key, value]);
    if (channel.writeFails) {
      return rejectUnreachable();
    }
    store.set(key, value);
    return Promise.resolve();
  }

  function clear(key: string): Promise<void> {
    store.delete(key);
    return Promise.resolve();
  }
}

function rejectUnreachable(): Promise<never> {
  return Promise.reject(new Error('shared store unreachable'));
}
