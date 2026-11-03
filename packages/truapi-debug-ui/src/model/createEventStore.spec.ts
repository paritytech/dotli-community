// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `version` says when `list()` needs re-reading, without diffing it. Its per-frame
// bookkeeping must follow the ring buffer exactly, at a cost proportional to what changed, not to what is retained.

import { describe, expect, it, onTestFinished } from 'vitest';
import { createManualTimers, nth } from '@dotli/shared/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { buildTruapiEvent } from '../testing/buildTruapiEvent.js';
import { createEventStore, type EventStore } from './createEventStore.js';
import type { StoredEvent } from './storedEvent.js';

const HEARTBEAT: DotliDebugEvent = buildSystemEvent({ layer: 'main', event: 'heartbeat', payload: { uptimeSec: 1 } });

function getEventId(event: StoredEvent): string {
  switch (event.kind) {
    case 'truapi':
      return event.requestId;
    case 'system':
      return event.flowId;
  }
}

function getEventName(event: StoredEvent): string {
  switch (event.kind) {
    case 'truapi':
      return event.tag;
    case 'system':
      return event.event;
  }
}

describe('createEventStore()', () => {
  it('As the debug panel, I insert past the capacity I was made with and the oldest events are evicted and counted as dropped', () => {
    // Given
    const store = createEventStore({ capacity: 2 });

    // When
    for (const requestId of ['r1', 'r2', 'r3']) {
      store.insertTruapi(buildTruapiEvent({ requestId }));
    }

    // Then
    expect(store.capacity).toBe(2);
    expect(store.list().map(event => getEventId(event))).toEqual(['r2', 'r3']);
    expect(store.dropped()).toBe(1);
  });

  it("As the debug panel, I insert a TrUAPI event and it is stamped with the store's clock at insert", async () => {
    // Given
    const timers = createManualTimers({ start: 1000 });
    const store = createEventStore({ capacity: 10, timers });
    store.insertTruapi(buildTruapiEvent({ requestId: 'r1' }));
    await timers.advance(250);

    // When
    store.insertTruapi(buildTruapiEvent({ requestId: 'r2' }));

    // Then
    expect(store.list().map(event => event.receivedAt)).toEqual([1000, 1250]);
  });

  it('As the debug panel, I insert a host event that carries an extra key and it is stored with only its record keys, in order', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    const event = { ...HEARTBEAT, extra: 'not stored' };

    // When
    store.insertDotli(event);

    // Then
    expect(Object.keys(nth(store.list(), 0))).toEqual([
      'kind',
      'seq',
      'receivedAt',
      'source',
      'layer',
      'event',
      'flowId',
      'payload',
    ]);
  });
});

describe('createEventStore() version.get()', () => {
  it.each([
    {
      change: 'insert a TrUAPI event',
      apply: (store: EventStore) => {
        store.insertTruapi(buildTruapiEvent({ requestId: 'r2' }));
      },
    },
    {
      change: 'insert a dotli event',
      apply: (store: EventStore) => {
        store.insertDotli(HEARTBEAT);
      },
    },
    {
      change: 'clear the events',
      apply: (store: EventStore) => {
        store.clear();
      },
    },
  ])('As the debug panel, I $change and the version goes up by one', ({ apply }) => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(buildTruapiEvent({ requestId: 'r1' }));
    const before = store.version.get();

    // When
    apply(store);

    // Then
    expect(store.version.get()).toBe(before + 1);
  });

  it('As the debug panel, I insert an event that evicts another and the version goes up once', () => {
    // Given
    const store = createEventStore({ capacity: 2 });
    store.insertTruapi(buildTruapiEvent({ requestId: 'r1' }));
    store.insertTruapi(buildTruapiEvent({ requestId: 'r2' }));
    const beforePrune = store.version.get();

    // When: at capacity 2, this insert evicts r1's event and prunes it in the same notify
    store.insertTruapi(buildTruapiEvent({ requestId: 'r3' }));

    // Then
    expect(store.dropped()).toBe(1);
    expect(store.version.get()).toBe(beforePrune + 1);
  });

  it('As the debug panel while paused, I insert events and they are dropped with the version unchanged', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.setPaused(true);
    const afterPause = store.version.get();

    // When
    store.insertTruapi(buildTruapiEvent({ requestId: 'r1' }));
    store.insertDotli(HEARTBEAT);

    // Then
    expect(store.version.get()).toBe(afterPause);
    expect(store.list()).toHaveLength(0);
  });
});

describe('createEventStore() version.listen()', () => {
  it('As the debug panel, I follow the version and hear each change once, with a count that only grows', () => {
    // Given
    const store = createEventStore({ capacity: 1 });
    const start = store.version.get();
    const heard: number[] = [];
    const unlisten = store.version.listen(version => {
      heard.push(version - start);
    });
    onTestFinished(unlisten);

    // When: the second insert evicts the first, and the repeated Pause changes nothing
    store.insertTruapi(buildTruapiEvent({ requestId: 'r1' }));
    store.insertTruapi(buildTruapiEvent({ requestId: 'r2' }));
    store.setPaused(true);
    store.setPaused(true);
    store.clear();

    // Then
    expect(heard).toEqual([1, 2, 3, 4]);
  });
});

describe('createEventStore() productIds()', () => {
  it('As the debug panel, I list the products of the kept events and the missing product id is among them', () => {
    // Given
    const store = createEventStore({ capacity: 3 });

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '1', productId: 'one.dot' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '2', productId: null }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '3', productId: 'one.dot' }));

    // Then
    expect(store.productIds().sort()).toEqual(['one.dot', undefined]);
  });

  it('As the debug panel, I evict an event of a product and the product stays while another of its events is kept', () => {
    // Given
    const store = createEventStore({ capacity: 3 });
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '1', productId: 'one.dot' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '2', productId: null }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '3', productId: 'one.dot' }));

    // When it evicts the first one.dot event
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '4', productId: 'two.dot' }));

    // Then
    expect(store.productIds().sort()).toEqual(['one.dot', 'two.dot', undefined]);
  });

  it('As the debug panel, I evict the last event of a product and the product goes, the missing product id among them', () => {
    // Given
    const store = createEventStore({ capacity: 3 });
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '1', productId: 'one.dot' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '2', productId: null }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '3', productId: 'one.dot' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '4', productId: 'two.dot' }));

    // When it evicts the event without a product id, then the last one.dot event
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '5', productId: 'two.dot' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '6', productId: 'two.dot' }));

    // Then
    expect(store.productIds()).toEqual(['two.dot']);
  });

  it('As the debug panel, I clear the events and no product is left', () => {
    // Given
    const store = createEventStore({ capacity: 3 });
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '1', productId: 'one.dot' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'a_request', requestId: '2', productId: null }));

    // When
    store.clear();

    // Then
    expect(store.productIds()).toEqual([]);
  });

  it('As the debug panel, I insert a system event and it adds no product', () => {
    // Given
    const store = createEventStore({ capacity: 3 });

    // When
    store.insertDotli(HEARTBEAT);

    // Then
    expect(store.productIds()).toEqual([]);
  });
});

describe('createEventStore() anchorOf()', () => {
  it('As the debug panel, I evict a request and its response stays grouped under it', () => {
    // Given
    const store = createEventStore({ capacity: 2 });
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'x_response', requestId: 'r1' }));
    const listed = store.list();
    const request = nth(listed, 0);
    const response = nth(listed, 1);

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'y_request', requestId: 'r2' }));

    // Then
    expect(store.firstInGroup('r1')).toBeUndefined();
    expect(store.anchorOf(response)).toBe(request);
  });
});

describe('createEventStore() while paused', () => {
  function listTags(store: EventStore): string[] {
    return store.list().map(event => getEventName(event));
  }

  it('As a developer who paused the debug panel, I get the reply to a call recorded before Pause and it is kept', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: 'r1' }));
    store.setPaused(true);

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1' }));

    // Then
    expect(listTags(store)).toEqual(['sign_request', 'sign_response']);
  });

  it('As a developer who paused the debug panel, I get the reply to a call that started after Pause and it is dropped', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.setPaused(true);
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: 'r1' }));
    const before = store.version.get();

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1' }));

    // Then
    expect(store.list()).toEqual([]);
    expect(store.version.get()).toBe(before);
  });

  it('As a developer who paused the debug panel, I get two replies to a recorded call and only the first is kept', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: 'r1' }));
    store.setPaused(true);

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1' }));

    // Then
    expect(listTags(store)).toEqual(['sign_request', 'sign_response']);
  });

  it('As a developer who paused the debug panel, I get a reply from another product that reuses the request id and it is dropped', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: 'r1', productId: 'a.dot' }));
    store.setPaused(true);

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1', productId: 'b.dot' }));

    // Then
    expect(listTags(store)).toEqual(['sign_request']);
  });

  it('As a developer who paused the debug panel, I get the reply to a call whose request was evicted and it is dropped', () => {
    // Given a ring of two that evicted r1's request
    const store = createEventStore({ capacity: 2 });
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: 'r1' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'other_request', requestId: 'r2' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'other_request', requestId: 'r3' }));
    store.setPaused(true);

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1' }));

    // Then
    expect(listTags(store)).toEqual(['other_request', 'other_request']);
  });

  it('As a developer who paused the debug panel after Clear, I get the reply to a call I cleared and it is dropped', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: 'r1' }));
    store.clear();
    store.setPaused(true);

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_response', requestId: 'r1' }));

    // Then
    expect(store.list()).toEqual([]);
  });
});
