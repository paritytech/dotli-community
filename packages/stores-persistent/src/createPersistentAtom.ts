// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, onNotify, onSet, type WritableAtom } from 'nanostores';
import type { SafeStorage } from '@dotli/shared';
import { readOnFirstUse } from './readOnFirstUse.js';

export type PersistentAtomParams<Value> = {
  /** The storage key. */
  key: string;
  /** Where the value is kept. Never throws. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The value when nothing usable is stored. Setting it back removes the key. */
  initial: Value;
  /** Parses the stored text, or returns undefined when it no longer parses. */
  decode: (raw: string) => Value | undefined;
  /** Turns a value into the stored text. */
  encode: (value: Value) => string;
};

/**
 * An atom that reads its stored value once, on the first read, listen or set, and writes each change back.
 *
 * A set before that read applies after it, so the caller's value wins. A storage that fails on every call leaves the
 * atom working in memory. It never follows the `storage` event, so another tab's write shows when it came before the
 * first read, and after a reload otherwise.
 *
 * @example
 * const dock = createPersistentAtom({ key: 'panel.dock', storage, initial: 'right', decode: parseDock, encode: String });
 */
export function createPersistentAtom<Value>(params: PersistentAtomParams<Value>): WritableAtom<Value> {
  const { key, storage, initial, encode } = params;
  const persistent = atom<Value>(initial);
  const lazy = readOnFirstUse(persistent, params);
  onSet(persistent, lazy.readOnce);
  onNotify(persistent, writeChange);
  return persistent;

  function writeChange(): void {
    // The stored value's own read writes nothing back.
    if (lazy.isReading()) {
      return;
    }
    const value = persistent.get();
    if (Object.is(value, initial)) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, encode(value));
  }
}
