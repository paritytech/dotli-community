// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';

/**
 * A map with one signal per key, so a reader re-runs only when its key changes (avoids HUGE_FAN_OUT across rows).
 *
 * Built on `createSignal` alone because Solid's store module would land in the shared chunk on the host's boot path.
 */
export interface KeyedSignals<K, V> {
  /** Inside a reactive owner, also subscribes to `key`. */
  read(key: K): V | undefined;
  /** `undefined` removes the key. */
  write(key: K, value: V | undefined): void;
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
  // A key's signal lives only while it has readers, counted via `onCleanup`, so disposed rows release it.
  const nodes = new Map<K, Node<V>>();

  return {
    read(key) {
      if (getOwner() === null) {
        return values.get(key);
      }
      let node = nodes.get(key);
      if (node === undefined) {
        const [get, set] = createSignal<V | undefined>(
          // In Solid 2 a function first argument makes a derived signal. The list stores no functions.
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
