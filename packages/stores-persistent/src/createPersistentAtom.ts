// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type WritableAtom } from 'nanostores';
import type { SafeStorage } from '@dotli/shared';
import { bindToStorage } from './bindToStorage.js';

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
 * An atom that reads its stored value once, on the first read, listen or set, and writes each set back.
 *
 * A set before that read applies after it, so the caller's value wins. A storage that fails on every call leaves the
 * atom working in memory. It never follows the `storage` event, so another tab's write shows when it came before the
 * first read, and after a reload otherwise.
 *
 * @example
 * const dock = createPersistentAtom({ key: 'panel.dock', storage, initial: 'right', decode: parseDock, encode: String });
 */
export function createPersistentAtom<Value>(params: PersistentAtomParams<Value>): WritableAtom<Value> {
  const persistent = atom<Value>(params.initial);
  // Every set applies, so the atom keeps working in memory when the storage drops the write.
  bindToStorage(persistent, params, () => true);
  return persistent;
}
