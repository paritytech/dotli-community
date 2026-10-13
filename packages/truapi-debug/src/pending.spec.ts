// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The open-call set must follow the ring buffer exactly, at a cost proportional to what changed.

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from './dotli-debug-types.js';
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

/** The reference result, recomputed from the whole snapshot. */
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
  it('As the debug panel, I keep the open calls equal to a full recompute, frame by frame and across clears', () => {
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
});
