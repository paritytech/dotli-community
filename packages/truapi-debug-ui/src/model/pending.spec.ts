// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The open-call set must follow the ring buffer exactly, at a cost proportional to what changed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { nth } from '@dotli/shared/testing';
import { EventStore, type StoredEvent } from './event-store.js';
import { OpenCallTracker } from './pending.js';

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

/** Inserts at `at` ms on the fake clock, so two copies of one request differ in time. */
function insertAt(store: EventStore, at: number, tag: string, requestId: string, productId?: string | null): void {
  vi.setSystemTime(at);
  insert(store, tag, requestId, productId);
}

/** The open calls after the tracker reads the store as it is now. */
function openAfterUpdate(tracker: OpenCallTracker, store: EventStore): Map<string, number> {
  tracker.update(store.list().slice());
  return new Map(tracker.open);
}

/** A cross-check only: recomputed from the whole snapshot, by rules written again here. */
function openCalls(events: readonly StoredEvent[]): Map<string, number> {
  const requestedAt = new Map<string, number>();
  const answered = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== 'truapi') {
      continue;
    }
    const key = `${ev.productId ?? 'dotli'}::${ev.requestId}`;
    if (ev.tag.endsWith('_response')) {
      answered.add(key);
    } else if (!requestedAt.has(key)) {
      requestedAt.set(key, ev.receivedAt);
    }
  }
  for (const key of answered) {
    requestedAt.delete(key);
  }
  return requestedAt;
}

describe('OpenCallTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('As the debug panel, I close a call whose request is evicted', () => {
    // Given
    const store = new EventStore({ capacity: 2 });
    const tracker = new OpenCallTracker();
    insert(store, 'x_request', 'r1');
    insert(store, 'x_request', 'r2');
    const [r1, r2] = [nth(store.list(), 0), nth(store.list(), 1)];
    expect(openAfterUpdate(tracker, store)).toEqual(
      new Map([
        ['app.dot::r1', r1.receivedAt],
        ['app.dot::r2', r2.receivedAt],
      ]),
    );

    // When
    insert(store, 'x_request', 'r3');

    // Then
    expect(openAfterUpdate(tracker, store)).toEqual(
      new Map([
        ['app.dot::r2', r2.receivedAt],
        ['app.dot::r3', nth(store.list(), 1).receivedAt],
      ]),
    );
  });

  it('As the debug panel, I time a repeated request from its first kept copy', () => {
    // Given two copies at distinct times, which only a set clock guarantees
    vi.useFakeTimers();
    const store = new EventStore({ capacity: 2 });
    const tracker = new OpenCallTracker();
    insertAt(store, 100, 'x_request', 'r1');
    insertAt(store, 200, 'x_request', 'r1');
    expect(openAfterUpdate(tracker, store)).toEqual(new Map([['app.dot::r1', 100]]));

    // When the first copy is evicted
    store.insertDotli(dotli('boot'));

    // Then
    expect(openAfterUpdate(tracker, store)).toEqual(new Map([['app.dot::r1', 200]]));
  });

  it('As the debug panel, I drop the open calls on a clear and open only what arrives after it', () => {
    // Given
    const store = new EventStore({ capacity: 10 });
    const tracker = new OpenCallTracker();
    insert(store, 'x_request', 'r1');
    openAfterUpdate(tracker, store);

    // When
    store.clear();
    insert(store, 'x_request', 'r2');

    // Then
    expect(openAfterUpdate(tracker, store)).toEqual(new Map([['app.dot::r2', nth(store.list(), 0).receivedAt]]));
  });

  it('As the debug panel, I keep the open calls equal to a full recompute over a random walk, as a cross-check', () => {
    // Given
    const store = new EventStore({ capacity: 25 });
    const tracker = new OpenCallTracker();
    // A fixed pseudo-random walk: requests, replies, noise and repeats.
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    // When / Then
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

  it('As the debug panel, I learn from each update whether the open calls changed', () => {
    // Given
    const store = new EventStore({ capacity: 10 });
    const tracker = new OpenCallTracker();

    // When
    insert(store, 'x_request', 'r1');

    // Then
    expect(tracker.update(store.list().slice())).toBe(true);

    // When
    insert(store, 'x_receive', 'r1');

    // Then
    expect(tracker.update(store.list().slice())).toBe(false);

    // When
    insert(store, 'x_response', 'r1');

    // Then
    expect(tracker.update(store.list().slice())).toBe(true);
  });

  it('As a developer who paused the debug panel, I see a call recorded before Pause stop reading pending when its reply lands', () => {
    // Given
    const store = new EventStore({ capacity: 10 });
    const tracker = new OpenCallTracker();
    insert(store, 'sign_request', 'r1');
    openAfterUpdate(tracker, store);
    store.setPaused(true);

    // When
    insert(store, 'sign_response', 'r1');

    // Then
    expect(openAfterUpdate(tracker, store).size).toBe(0);
  });
});
