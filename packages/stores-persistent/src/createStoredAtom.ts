// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type WritableAtom } from 'nanostores';
import type { PersistentAtomParams } from './createPersistentAtom.js';
import { bindToStorage } from './bindToStorage.js';

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
  const { key, storage, initial } = params;
  const stored = atom<Value>(initial);
  // Compares the stored text, so a value that decode rebuilds as a new object still reads back as held.
  bindToStorage(stored, params, written => storage.getItem(key) === written);
  return stored;
}
