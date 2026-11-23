// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSafeStorage } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createStoredAtom } from './createStoredAtom.js';
import { decodeNumber, encodeNumber } from './testing/numberCodec.js';
import { openBlocked } from './testing/openBlocked.js';

describe('createStoredAtom', () => {
  it('As a writer, I set a value and it is stored through my encode, and the atom shows it', () => {
    // Given
    const backing = createMemoryStorage();
    const storage = createSafeStorage(() => backing);
    const count = createStoredAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: raw => Number(raw.slice(1)),
      encode: value => `n${String(value)}`,
    });

    // When
    count.set(9);

    // Then
    expect([count.get(), backing.getItem('count')]).toEqual([9, 'n9']);
  });

  it('As a page whose storage throws on every call, I set a value and the atom keeps what the storage holds', () => {
    // Given
    const storage = createSafeStorage(openBlocked);
    const count = createStoredAtom({
      key: 'count',
      storage,
      initial: 3,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    const first = count.get();
    count.set(5);

    // Then
    expect([first, count.get()]).toEqual([3, 3]);
  });

  it('As a writer who sets before anything read, I keep my value over the stored one, and setting the initial value then removes the key', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);
    const count = createStoredAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    count.set(9);
    const afterSet = [count.get(), backing.getItem('count')];
    count.set(0);

    // Then
    expect([afterSet, backing.getItem('count')]).toEqual([[9, '9'], null]);
  });

  it('As a page, I start a stored atom and the value it reads writes nothing back', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7.0' } });
    const storage = createSafeStorage(() => backing);
    const count = createStoredAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });
    const heard: number[] = [];

    // When
    count.listen(value => {
      heard.push(value);
    });

    // Then
    expect([count.get(), backing.getItem('count'), heard]).toEqual([7, '7.0', []]);
  });
});
