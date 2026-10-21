// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRenderEffect, createRoot, flush } from 'solid-js';
import { createKeyedSignals, type KeyedSignals } from './keyed-signals.js';

/** A reader of each of keys `a` and `b`, with how often each ran and what `a`'s reader saw. */
function readers(map: KeyedSignals<string, number>) {
  const runs = { a: 0, b: 0 };
  const seen: (number | undefined)[] = [];
  const dispose = createRoot(d => {
    createRenderEffect(
      () => {
        runs.a++;
        return map.read('a');
      },
      v => {
        seen.push(v);
      },
    );
    createRenderEffect(
      () => {
        runs.b++;
        return map.read('b');
      },
      () => undefined,
    );
    return d;
  });
  flush();
  return { runs, seen, dispose };
}

describe('createKeyedSignals()', () => {
  it('As the debug panel, I re-run only the readers of a written key, once for a repeated value', () => {
    // Given
    const map = createKeyedSignals<string, number>();
    map.write('a', 1);
    const { runs, seen, dispose } = readers(map);

    // When
    map.write('a', 2);
    map.write('a', 2);
    flush();

    // Then
    expect(runs).toEqual({ a: 2, b: 1 });
    expect(seen).toEqual([1, 2]);
    dispose();
  });

  it('As the debug panel, I release a key once its readers go and keep its value', () => {
    // Given
    const map = createKeyedSignals<string, number>();
    map.write('a', 1);
    const { dispose } = readers(map);
    expect([...map.subscribedKeys()].sort()).toEqual(['a', 'b']);

    // When
    dispose();

    // Then
    expect([...map.subscribedKeys()]).toEqual([]);
    map.write('b', 5);
    expect(map.read('b')).toBe(5);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
  });
});
