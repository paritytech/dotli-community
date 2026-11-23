// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSet, onStart, type WritableAtom } from 'nanostores';
import type { PersistentAtomParams } from './createPersistentAtom.js';

/**
 * Binds `target` to `key` in `storage`. It reads the stored value once, on the first read, listen or set, and writes
 * each set before it applies, removing the key at the initial value. A set before that read applies after it, so the
 * caller's value wins. The read's own set writes nothing back.
 *
 * `held` says whether a set applies, given what was just written: its text, or null for a removed key.
 */
export function bindToStorage<Value>(
  target: WritableAtom<Value>,
  { key, storage, initial, decode, encode }: PersistentAtomParams<Value>,
  held: (written: string | null) => boolean,
): void {
  let read = false;
  let reading = false;
  onStart(target, readOnce);
  onSet(target, event => {
    readOnce();
    // The stored value's own read writes nothing back.
    if (reading) {
      return;
    }
    if (!held(write(event.newValue))) {
      event.abort();
    }
  });

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

  /** Writes `value`, or removes the key at the initial value. Returns the text written, or null for a removal. */
  function write(value: Value): string | null {
    if (Object.is(value, initial)) {
      storage.removeItem(key);
      return null;
    }
    const text = encode(value);
    storage.setItem(key, text);
    return text;
  }
}
