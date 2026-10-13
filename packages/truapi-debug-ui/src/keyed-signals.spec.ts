// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRenderEffect, createRoot, flush } from 'solid-js';
import { createKeyedSignals } from './keyed-signals.js';

describe('createKeyedSignals()', () => {
  it('As the debug panel, I re-run only the readers of a written key and release a key once its readers go', () => {
    // Given a reader of each of two keys
    const map = createKeyedSignals<string, number>();
    map.write('a', 1);
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
    expect([...map.subscribedKeys()].sort()).toEqual(['a', 'b']);

    // When one key is written twice with the same value
    map.write('a', 2);
    map.write('a', 2);
    flush();

    // Then only its reader re-runs, once
    expect(runs).toEqual({ a: 2, b: 1 });
    expect(seen).toEqual([1, 2]);

    // When the readers go
    dispose();

    // Then no key is held for them, and the values stay
    expect([...map.subscribedKeys()]).toEqual([]);
    map.write('b', 5);
    expect(map.read('b')).toBe(5);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
  });
});
