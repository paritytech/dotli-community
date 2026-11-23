// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onStart, type WritableAtom } from 'nanostores';
import type { PersistentAtomParams } from './createPersistentAtom.js';

type Params<Value> = Pick<PersistentAtomParams<Value>, 'key' | 'storage' | 'initial' | 'decode'>;

/**
 * Reads `key` into `target` once, on its first get or listen, so a module may build the atom at import.
 *
 * The caller calls `readOnce` from its own `onSet` too, so a set before the first read applies after it.
 */
export function readOnFirstUse<Value>(target: WritableAtom<Value>, { key, storage, initial, decode }: Params<Value>) {
  let read = false;
  let reading = false;
  onStart(target, readOnce);

  return {
    /** Reads the stored value into the atom, the first time only. */
    readOnce,
    /** True while the stored value's own read is being set, which writes nothing back. */
    isReading: () => reading,
  };

  function readOnce(): void {
    if (read) {
      return;
    }
    read = true;
    reading = true;
    target.set(readStored());
    reading = false;
  }

  function readStored(): Value {
    const raw = storage.getItem(key);
    if (raw === null) {
      return initial;
    }
    const decoded = decode(raw);
    if (decoded === undefined) {
      return initial;
    }
    return decoded;
  }
}
