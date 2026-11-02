// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { createRenderEffect, createRoot, flush } from 'solid-js';
import { createKeyedSignals, type KeyedSignals } from './createKeyedSignals.js';

/** A reader of each of keys `a` and `b`, with how often each ran and what `a`'s reader saw. */
function mountReaders(map: KeyedSignals<string, number>) {
  const runs = { a: 0, b: 0 };
  const seen: (number | undefined)[] = [];
  const dispose = createRoot(disposeRoot => {
    createRenderEffect(
      () => {
        runs.a++;
        return map.read('a');
      },
      value => {
        seen.push(value);
      },
    );
    createRenderEffect(
      () => {
        runs.b++;
        return map.read('b');
      },
      () => undefined,
    );
    return disposeRoot;
  });
  flush();
  return { runs, seen, dispose };
}

describe('createKeyedSignals()', () => {
  it('As the debug panel, I write a key twice with one value and only its readers re-run, once', () => {
    // Given
    const map = createKeyedSignals<string, number>();
    map.write('a', 1);
    const { runs, seen, dispose } = mountReaders(map);
    onTestFinished(dispose);

    // When
    map.write('a', 2);
    map.write('a', 2);
    flush();

    // Then
    expect(runs).toEqual({ a: 2, b: 1 });
    expect(seen).toEqual([1, 2]);
  });

  it('As the debug panel, I dispose the readers of a key and it is released with its value kept', () => {
    // Given
    const map = createKeyedSignals<string, number>();
    map.write('a', 1);
    const { dispose } = mountReaders(map);
    const subscribedWhileRead = [...map.subscribedKeys()].sort();

    // When
    dispose();
    map.write('b', 5);

    // Then
    expect(subscribedWhileRead).toEqual(['a', 'b']);
    expect([...map.subscribedKeys()]).toEqual([]);
    expect(map.read('b')).toBe(5);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
  });
});
