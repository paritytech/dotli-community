// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, onSet, type WritableAtom } from 'nanostores';
import type { PersistentAtomParams } from './createPersistentAtom.js';
import { readOnFirstUse } from './readOnFirstUse.js';

/**
 * An atom that holds only what its storage keeps. It reads its stored value once, on the first read, listen or set,
 * and writes each set through and reads it back, so a set the storage drops leaves the atom as it was.
 *
 * A set before that read applies after it, so the caller's value wins. Setting the initial value removes the key. It
 * never follows the `storage` event, so another tab's write shows when it came before the first read, and after a
 * reload otherwise.
 *
 * @example
 * const claim = createStoredAtom({ key: 'claim', storage, initial: '', decode: raw => raw, encode: build => build });
 */
export function createStoredAtom<Value>(params: PersistentAtomParams<Value>): WritableAtom<Value> {
  const { key, storage, initial, encode } = params;
  const stored = atom<Value>(initial);
  const lazy = readOnFirstUse(stored, params);
  onSet(stored, event => {
    lazy.readOnce();
    // The stored value's own read writes nothing back.
    if (lazy.isReading()) {
      return;
    }
    if (!writeThrough(event.newValue)) {
      event.abort();
    }
  });
  return stored;

  /** Writes `value`, or removes the key at the initial value, and says whether the storage now holds it. */
  function writeThrough(value: Value): boolean {
    if (Object.is(value, initial)) {
      storage.removeItem(key);
      return storage.getItem(key) === null;
    }
    // Compares the stored text, so a value that decode rebuilds as a new object still reads back as held.
    const text = encode(value);
    storage.setItem(key, text);
    return storage.getItem(key) === text;
  }
}
