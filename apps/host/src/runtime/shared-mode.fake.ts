// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SharedChannel } from './shared-mode.js';

export interface MemorySharedChannel extends SharedChannel {
  /** What the cross-subdomain store holds. */
  readonly store: Map<string, string>;
  /** Every write the store was asked for, in order, failed ones included. */
  readonly writes: [key: string, value: string][];
  /** Reads reject, as when the storage frame cannot be reached. */
  readFails: boolean;
  /** Writes reject and leave the store as it was. */
  writeFails: boolean;
}

/** The cross-subdomain store as a map, which a test can make unreachable. */
export function memorySharedChannel(entries: Record<string, string> = {}): MemorySharedChannel {
  const unreachable = (): Promise<never> => Promise.reject(new Error('shared store unreachable'));
  const channel: MemorySharedChannel = {
    store: new Map(Object.entries(entries)),
    writes: [],
    readFails: false,
    writeFails: false,
    read: key => (channel.readFails ? unreachable() : Promise.resolve(channel.store.get(key) ?? null)),
    write: (key, value) => {
      channel.writes.push([key, value]);
      if (channel.writeFails) {
        return unreachable();
      }
      channel.store.set(key, value);
      return Promise.resolve();
    },
    clear: key => {
      channel.store.delete(key);
      return Promise.resolve();
    },
  };
  return channel;
}
