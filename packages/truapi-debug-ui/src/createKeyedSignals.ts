// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';

/**
 * A map with one signal per key, so a reader re-runs only when its key changes (avoids HUGE_FAN_OUT across rows).
 *
 * Built on `createSignal` alone because Solid's store module would land in the shared chunk on the host's boot path.
 */
export type KeyedSignals<Key, Value> = ReturnType<typeof createKeyedSignals<Key, Value>>;

type Node<Value> = {
  get: Accessor<Value | undefined>;
  set: (value: Value | undefined) => void;
  readers: number;
};

/** Creates an empty keyed signal map. */
export function createKeyedSignals<Key, Value>() {
  const values = new Map<Key, Value>();
  // A key's signal lives only while it has readers, counted via `onCleanup`, so disposed rows release it.
  const nodes = new Map<Key, Node<Value>>();

  return {
    /** The value at `key`, or undefined. Inside a reactive owner, also subscribes to `key`. Never throws. */
    read(key: Key): Value | undefined {
      if (getOwner() === null) {
        return values.get(key);
      }
      let node = nodes.get(key);
      if (node === undefined) {
        const [get, set] = createSignal<Value | undefined>(
          // In Solid 2 a function first argument makes a derived signal. The list stores no functions.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
          values.get(key) as Exclude<Value | undefined, Function>,
          {
            // Written through `write`, not from the reader's owner.
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
    /** Sets `key` to `value` and re-runs its readers when it changed. `undefined` removes the key. Never throws. */
    write(key: Key, value: Value | undefined): void {
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
    /** The keys that hold a value. Never throws. */
    keys(): IterableIterator<Key> {
      return values.keys();
    },
    /** The keys some reader is subscribed to. Tests only. Never throws. */
    subscribedKeys(): IterableIterator<Key> {
      return nodes.keys();
    },
  };
}
