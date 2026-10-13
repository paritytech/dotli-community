// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `EventStore.version()` tells a Solid adapter when `list()` needs re-reading, without diffing it. Its per-frame
// bookkeeping must follow the ring buffer exactly, at a cost proportional to what changed, not to what is retained.

import { describe, expect, it } from 'vitest';
import { nth } from '@dotli/shared/testing';
import type { DotliDebugEvent } from './dotli-debug-types.js';
import { EventStore, firstNewIndex, type StoredEvent, type TruapiDebugMessageEvent } from './event-store.js';

function truapiEvent(requestId: string): TruapiDebugMessageEvent {
  return {
    kind: 'truapi',
    direction: 'outgoing',
    requestId,
    payload: { tag: 'example_request', value: { n: 1 } },
  };
}

function dotliEvent(flowId: string): DotliDebugEvent {
  return {
    layer: 'main',
    event: 'heartbeat',
    flowId,
    timestamp: Date.now(),
    payload: { uptimeSec: 1 },
  };
}

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

describe('EventStore.version()', () => {
  it('As the debug panel, I see a new event store at version 0', () => {
    // When
    const store = new EventStore({ capacity: 10 });

    // Then
    expect(store.version()).toBe(0);
  });

  it('As the debug panel, I see the version go up when a TrUAPI event comes in', () => {
    // Given
    const store = new EventStore({ capacity: 10 });

    // When
    store.insertTruapi(truapiEvent('r1'));

    // Then
    expect(store.version()).toBe(1);
  });

  it('As the debug panel, I see the version go up when a dotli event comes in', () => {
    // Given
    const store = new EventStore({ capacity: 10 });

    // When
    store.insertDotli(dotliEvent('f1'));

    // Then
    expect(store.version()).toBe(1);
  });

  it('As the debug panel, I see the version go up when the events are cleared', () => {
    // Given
    const store = new EventStore({ capacity: 10 });
    store.insertTruapi(truapiEvent('r1'));
    const afterInsert = store.version();

    // When
    store.clear();

    // Then
    expect(store.version()).toBe(afterInsert + 1);
  });

  it('As the debug panel, I see the version go up once for an event that evicts another', () => {
    // Given
    const store = new EventStore({ capacity: 2 });
    store.insertTruapi(truapiEvent('r1'));
    store.insertTruapi(truapiEvent('r2'));
    const beforePrune = store.version();

    // When: at capacity 2, this insert evicts r1's event and prunes it in the same notify
    store.insertTruapi(truapiEvent('r3'));

    // Then
    expect(store.dropped()).toBe(1);
    expect(store.version()).toBe(beforePrune + 1);
  });

  it('As the debug panel paused, I see events dropped and the version unchanged', () => {
    // Given
    const store = new EventStore({ capacity: 10 });
    store.setPaused(true);
    const afterPause = store.version();

    // When
    store.insertTruapi(truapiEvent('r1'));
    store.insertDotli(dotliEvent('f1'));

    // Then
    expect(store.version()).toBe(afterPause);
    expect(store.list()).toHaveLength(0);
  });
});

describe('EventStore.productIds()', () => {
  it('As the debug panel, I see the products of the kept events follow inserts, evictions and a clear without a scan', () => {
    // Given
    const store = new EventStore({ capacity: 3 });
    const visits = countIterations(store);

    // When
    insert(store, 'a_request', '1', 'one.dot');
    insert(store, 'a_request', '2', null);
    insert(store, 'a_request', '3', 'one.dot');

    // Then
    expect(store.productIds().sort()).toEqual(['one.dot', undefined]);

    // When: it evicts the first one.dot event, while another is still kept
    insert(store, 'a_request', '4', 'two.dot');

    // Then
    expect(store.productIds().sort()).toEqual(['one.dot', 'two.dot', undefined]);

    // When: it evicts the event without a product id, then the last one.dot event
    insert(store, 'a_request', '5', 'two.dot');

    // Then
    expect(store.productIds().sort()).toEqual(['one.dot', 'two.dot']);

    // When
    insert(store, 'a_request', '6', 'two.dot');

    // Then
    expect(store.productIds()).toEqual(['two.dot']);

    // When
    store.clear();

    // Then
    expect(store.productIds()).toEqual([]);
    expect(visits()).toBe(0);
  });

  it('As the debug panel, I see no product for a system event', () => {
    // Given
    const store = new EventStore({ capacity: 3 });

    // When
    store.insertDotli(dotli('boot'));

    // Then
    expect(store.productIds()).toEqual([]);
  });
});

describe('EventStore.anchorOf()', () => {
  it('As the debug panel, I keep a response grouped under its request after the request is evicted', () => {
    // Given
    const store = new EventStore({ capacity: 2 });
    insert(store, 'x_request', 'r1');
    insert(store, 'x_response', 'r1');
    const listed = store.list();
    const request = nth(listed, 0);
    const response = nth(listed, 1);

    // When
    insert(store, 'y_request', 'r2');

    // Then
    expect(store.firstInGroup('r1')).toBeUndefined();
    expect(store.anchorOf(response)).toBe(request);
  });
});

describe('firstNewIndex()', () => {
  const ev = (seq: number): StoredEvent => ({ seq }) as StoredEvent;

  it("As the debug panel's list, I find the first event past the previous snapshot's last one", () => {
    // When / Then
    expect(firstNewIndex([], [ev(0), ev(1)])).toBe(0);
    expect(firstNewIndex([ev(0), ev(1)], [ev(0), ev(1)])).toBe(2);
    expect(firstNewIndex([ev(0), ev(1)], [ev(1), ev(2), ev(3)])).toBe(1);
    expect(firstNewIndex([ev(0), ev(1)], [ev(7), ev(8)])).toBe(0);
    expect(firstNewIndex([ev(0), ev(1)], [])).toBe(0);
  });

  it("As the debug panel's list, I find the first new event from the last seq seen in place of a snapshot", () => {
    // When / Then
    expect(firstNewIndex({ lastSeq: -1 }, [ev(0), ev(1)])).toBe(0);
    expect(firstNewIndex({ lastSeq: 1 }, [ev(0), ev(1)])).toBe(2);
    expect(firstNewIndex({ lastSeq: 1 }, [ev(1), ev(2), ev(3)])).toBe(1);
    expect(firstNewIndex({ lastSeq: 1 }, [ev(7), ev(8)])).toBe(0);
    expect(firstNewIndex({ lastSeq: 1 }, [])).toBe(0);
  });
});
