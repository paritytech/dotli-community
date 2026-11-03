// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type WritableAtom } from 'nanostores';
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
  /** Turns a value into the stored text. Defaults to `JSON.stringify`. */
  encode?: (value: Value) => string;
};

/**
 * An atom that starts from its stored value and writes each change back.
 *
 * It reads once when built and never follows the `storage` event, so another tab's write shows after a reload.
 */
export function createPersistentAtom<Value>({
  key,
  storage,
  initial,
  decode,
  encode = JSON.stringify,
}: PersistentAtomParams<Value>): WritableAtom<Value> {
  const persistent = atom<Value>(readStored());
  persistent.listen(value => {
    if (Object.is(value, initial)) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, encode(value));
  });
  return persistent;

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
