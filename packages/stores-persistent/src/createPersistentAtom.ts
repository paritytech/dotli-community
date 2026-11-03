// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, onNotify, onSet, onStart, type WritableAtom } from 'nanostores';
import type { SafeStorage } from '@dotli/shared';

export type PersistentAtomParams<Value> = {
  /** The storage key. */
  key: string;
  /** Where the value is kept. A storage that fails on every call leaves the atom working in memory. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The value when nothing usable is stored. Setting it back removes the key. */
  initial: Value;
  /** Parses the stored text, or returns undefined when it no longer parses. Never throws. */
  decode: (raw: string) => Value | undefined;
  /** Turns a value into the stored text. Never throws. */
  encode: (value: Value) => string;
};

/**
 * An atom that reads its stored value once, on the first read, listen or set, and writes each change back.
 *
 * A set before that read applies after it, so the caller's value wins. It never follows the `storage` event, so
 * another tab's write shows when it came before the first read, and after a reload otherwise.
 *
 * @example
 * const dock = createPersistentAtom({ key: 'panel.dock', storage, initial: 'right', decode: parseDock, encode: String });
 */
export function createPersistentAtom<Value>({
  key,
  storage,
  initial,
  decode,
  encode,
}: PersistentAtomParams<Value>): WritableAtom<Value> {
  const persistent = atom<Value>(initial);
  let read = false;
  let reading = false;
  // Read on the first get, listen or set, so a module may build the atom at import.
  onStart(persistent, readOnce);
  onSet(persistent, readOnce);
  onNotify(persistent, writeChange);
  return persistent;

  function readOnce(): void {
    if (read) {
      return;
    }
    read = true;
    reading = true;
    persistent.set(readStored());
    reading = false;
  }

  function writeChange(): void {
    // The stored value's own read writes nothing back.
    if (reading) {
      return;
    }
    const value = persistent.get();
    if (Object.is(value, initial)) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, encode(value));
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
