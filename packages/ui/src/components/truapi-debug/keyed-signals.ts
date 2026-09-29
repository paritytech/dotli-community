// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';

/**
 * A map of values, each with its own signal, so a reader of one key re-runs
 * only when that key's value changes. The list uses it where many rows would
 * otherwise read one shared signal (a HUGE_FAN_OUT at the 2000-row capacity).
 *
 * Built on `createSignal` alone: Solid's store module (`createStore`,
 * `createProjection`) would land in the shared Solid chunk on the host's
 * startup path, although only this lazily loaded panel needs it.
 */
export interface KeyedSignals<K, V> {
  /** The value at `key`. Inside a reactive owner, also subscribes to it. */
  read(key: K): V | undefined;
  /** Set (or with `undefined`, remove) the value at `key`, notifying its
   *  readers if it changed. */
  write(key: K, value: V | undefined): void;
  /** The keys holding a value. */
  keys(): IterableIterator<K>;
  /** The keys some reader is subscribed to. Tests only. */
  subscribedKeys(): IterableIterator<K>;
}

interface Node<V> {
  get: Accessor<V | undefined>;
  set: (value: V | undefined) => void;
  readers: number;
}

export function createKeyedSignals<K, V>(): KeyedSignals<K, V> {
  const values = new Map<K, V>();
  // A per-key signal exists only while something reads that key. Readers
  // are counted with `onCleanup`, so a disposed row (evicted, or re-run)
  // releases its entry and nothing accumulates.
  const nodes = new Map<K, Node<V>>();

  return {
    read(key) {
      if (getOwner() === null) {
        return values.get(key);
      }
      let node = nodes.get(key);
      if (node === undefined) {
        const [get, set] = createSignal<V | undefined>(
          // Value form: in Solid 2 a function first argument makes a derived
          // signal. The list stores no functions.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
          values.get(key) as Exclude<V | undefined, Function>,
          {
            // Written from the list's effect, not from the reader's owner.
            ownedWrite: true,
          },
        );
        node = {
          get,
          set: value => {
            set(() => value);
          },
          readers: 0,
        };
        nodes.set(key, node);
      }
      const current = node;
      current.readers++;
      onCleanup(() => {
        current.readers--;
        if (current.readers === 0 && nodes.get(key) === current) {
          nodes.delete(key);
        }
      });
      return current.get();
    },
    write(key, value) {
      if (values.get(key) === value) {
        return;
      }
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      nodes.get(key)?.set(value);
    },
    keys() {
      return values.keys();
    },
    subscribedKeys() {
      return nodes.keys();
    },
  };
}
