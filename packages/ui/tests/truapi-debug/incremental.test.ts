// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the incremental bookkeeping the debug panel reads once per
// frame: product ids, group anchors, the new tail of a snapshot, open calls
// and the Resolution recorder. Each must follow the ring buffer exactly while
// costing work proportional to what changed, not to what is retained.

import { describe, expect, it } from 'vitest';
import { createRenderEffect, createRoot, flush } from 'solid-js';
import { createKeyedSignals } from '../../src/components/truapi-debug/keyed-signals.js';
import {
  EventStore,
  firstNewIndex,
  type StoredEvent,
  OpenCallTracker,
  openCalls,
  createResolutionRecorder,
} from '@dotli/truapi-debug';

import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { nth } from '../helpers/nth.js';

function insert(
  store: EventStore,
  tag: string,
  requestId: string,
  /** `null` inserts an event without a product id. */
  productId: string | null = 'app.dot',
): void {
  store.insertTruapi({
    kind: 'truapi',
    direction: 'outgoing',
    ...(productId !== null ? { productId } : {}),
    requestId,
    payload: { tag, value: {} },
  });
}

function dotli(layer: string, event = 'started'): DotliDebugEvent {
  return {
    layer,
    event,
    flowId: 'f',
    timestamp: 0,
    payload: {},
  } as unknown as DotliDebugEvent;
}

/** Count how often `list()`'s array is iterated from now on. */
function countIterations(store: EventStore): () => number {
  const buf = store.list() as StoredEvent[] & {
    [Symbol.iterator]: () => ArrayIterator<StoredEvent>;
  };
  let visits = 0;
  const iterate = Array.prototype[Symbol.iterator];
  Object.defineProperty(buf, Symbol.iterator, {
    configurable: true,
    value(this: StoredEvent[]) {
      visits++;
      return iterate.call(this);
    },
  });
  return () => visits;
}

describe('EventStore.productIds()', () => {
  it('follows inserts, eviction and clear without scanning the buffer', () => {
    const store = new EventStore({ capacity: 3 });
    const visits = countIterations(store);

    insert(store, 'a_request', '1', 'one.dot');
    insert(store, 'a_request', '2', null);
    insert(store, 'a_request', '3', 'one.dot');
    expect(store.productIds().sort()).toEqual(['one.dot', undefined]);

    // Evicts the first one.dot event; another is still retained.
    insert(store, 'a_request', '4', 'two.dot');
    expect(store.productIds().sort()).toEqual(['one.dot', 'two.dot', undefined]);

    // Evicts the event without a product id, then the last one.dot event.
    insert(store, 'a_request', '5', 'two.dot');
    expect(store.productIds().sort()).toEqual(['one.dot', 'two.dot']);
    insert(store, 'a_request', '6', 'two.dot');
    expect(store.productIds()).toEqual(['two.dot']);

    store.clear();
    expect(store.productIds()).toEqual([]);
    expect(visits()).toBe(0);
  });

  it('ignores system events', () => {
    const store = new EventStore({ capacity: 3 });
    store.insertDotli(dotli('boot'));
    expect(store.productIds()).toEqual([]);
  });
});

describe('EventStore.anchorOf()', () => {
  it('keeps the group anchor an event had when it was inserted, after the anchor is evicted', () => {
    const store = new EventStore({ capacity: 2 });
    insert(store, 'x_request', 'r1');
    insert(store, 'x_response', 'r1');
    const listed = store.list();
    const request = nth(listed, 0);
    const response = nth(listed, 1);

    insert(store, 'y_request', 'r2');

    expect(store.firstInGroup('r1')).toBeUndefined();
    expect(store.anchorOf(response)).toBe(request);
  });
});

describe('firstNewIndex()', () => {
  const ev = (seq: number): StoredEvent => ({ seq }) as StoredEvent;

  it("finds the first event past the previous snapshot's last one", () => {
    expect(firstNewIndex([], [ev(0), ev(1)])).toBe(0);
    expect(firstNewIndex([ev(0), ev(1)], [ev(0), ev(1)])).toBe(2);
    expect(firstNewIndex([ev(0), ev(1)], [ev(1), ev(2), ev(3)])).toBe(1);
    expect(firstNewIndex([ev(0), ev(1)], [ev(7), ev(8)])).toBe(0);
    expect(firstNewIndex([ev(0), ev(1)], [])).toBe(0);
  });

  it('takes the last seq seen in place of the previous snapshot', () => {
    expect(firstNewIndex({ lastSeq: -1 }, [ev(0), ev(1)])).toBe(0);
    expect(firstNewIndex({ lastSeq: 1 }, [ev(0), ev(1)])).toBe(2);
    expect(firstNewIndex({ lastSeq: 1 }, [ev(1), ev(2), ev(3)])).toBe(1);
    expect(firstNewIndex({ lastSeq: 1 }, [ev(7), ev(8)])).toBe(0);
    expect(firstNewIndex({ lastSeq: 1 }, [])).toBe(0);
  });
});

describe('OpenCallTracker', () => {
  it('matches openCalls over a ring buffer, frame by frame, including clears', () => {
    const store = new EventStore({ capacity: 25 });
    const tracker = new OpenCallTracker();
    // A fixed pseudo-random walk: requests, replies, noise and repeats.
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let frame = 0; frame < 200; frame++) {
      const burst = rand(6);
      for (let i = 0; i < burst; i++) {
        const id = `r${String(rand(15))}`;
        const product = rand(3) === 0 ? null : `p${String(rand(2))}`;
        const kind = rand(3);
        const tag = kind === 0 ? 'x_request' : kind === 1 ? 'x_response' : 'x_receive';
        insert(store, tag, id, product);
      }
      if (frame === 120) {
        store.clear();
      }
      if (frame % 3 === 0) {
        store.insertDotli(dotli('boot'));
      }
      const events = store.list().slice();
      tracker.update(events);
      expect(new Map(tracker.open)).toEqual(openCalls(events));
    }
  });

  it('reports whether the open set changed', () => {
    const store = new EventStore({ capacity: 10 });
    const tracker = new OpenCallTracker();
    insert(store, 'x_request', 'r1');
    expect(tracker.update(store.list().slice())).toBe(true);
    insert(store, 'x_receive', 'r1');
    expect(tracker.update(store.list().slice())).toBe(false);
    insert(store, 'x_response', 'r1');
    expect(tracker.update(store.list().slice())).toBe(true);
  });
});

describe('createResolutionRecorder()', () => {
  it('keeps the newest 4000 kept-layer events without reallocating once full', () => {
    const recorder = createResolutionRecorder();
    for (let i = 0; i < 4000; i++) {
      recorder.record(dotli('boot', `e${String(i)}`));
    }
    const full = recorder.events();

    recorder.record(dotli('boot', 'e4000'));
    recorder.record(dotli('boot', 'e4001'));

    expect(recorder.events()).toBe(full);
    expect(full).toHaveLength(4000);
    expect(full[0]?.event).toBe('e2');
    expect(full[3999]?.event).toBe('e4001');
  });

  it('bumps its version on a kept event and on clear only', () => {
    const recorder = createResolutionRecorder();
    const v0 = recorder.version();
    recorder.record(dotli('bridge'));
    expect(recorder.version()).toBe(v0);
    recorder.record(dotli('resolve'));
    expect(recorder.version()).toBe(v0 + 1);
    recorder.clear();
    expect(recorder.version()).toBe(v0 + 2);
  });
});

describe('createKeyedSignals()', () => {
  it('re-runs only the readers of a written key, and releases a key when its readers go', () => {
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

    map.write('a', 2);
    map.write('a', 2);
    flush();
    expect(runs).toEqual({ a: 2, b: 1 });
    expect(seen).toEqual([1, 2]);

    dispose();
    expect([...map.subscribedKeys()]).toEqual([]);
    map.write('b', 5);
    expect(map.read('b')).toBe(5);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
  });
});
