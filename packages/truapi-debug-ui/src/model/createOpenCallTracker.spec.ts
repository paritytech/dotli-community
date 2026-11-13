// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The open-call set must follow the ring buffer exactly, at a cost proportional to what changed.

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { createManualTimers, nth } from '@dotli/shared/testing';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { buildTruapiEvent } from '../testing/buildTruapiEvent.js';
import { createEventStore, type EventStore } from './createEventStore.js';
import { createOpenCallTracker, type OpenCallTracker } from './createOpenCallTracker.js';
import type { StoredEvent } from './storedEvent.js';

/** A request, a reply and a message that is neither, picked at random by the walk. */
const WALK_TAGS = ['x_request', 'x_response', 'x_receive'] as const;

const TOPBAR_READY: DotliDebugEvent = buildSystemEvent({ layer: 'boot', event: 'topbar_ready', payload: {} });

/** The open calls after the tracker reads the store as it is now. */
function readOpenAfterUpdate(tracker: OpenCallTracker, store: EventStore): Map<string, number> {
  tracker.update(store.list().slice());
  return new Map(tracker.open());
}

/** A cross-check only: recomputed from the whole snapshot, by rules written again here. */
function computeOpenCalls(events: readonly StoredEvent[]): Map<string, number> {
  const requestedAt = new Map<string, number>();
  const answered = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'truapi') {
      continue;
    }
    const key = `${event.productId ?? 'dotli'}::${event.requestId}`;
    if (event.tag.endsWith('_response')) {
      answered.add(key);
    } else if (!requestedAt.has(key)) {
      requestedAt.set(key, event.receivedAt);
    }
  }
  for (const key of answered) {
    requestedAt.delete(key);
  }
  return requestedAt;
}

describe('createOpenCallTracker()', () => {
  it('As the debug panel, I evict the request of a call and the call is no longer open', () => {
    // Given
    const store = createEventStore({ capacity: 2 });
    const tracker = createOpenCallTracker();
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r2' }));
    const [r1, r2] = [nth(store.list(), 0), nth(store.list(), 1)];

    // When
    const openBefore = readOpenAfterUpdate(tracker, store);

    // Then
    expect(openBefore).toEqual(
      new Map([
        ['app.dot::r1', r1.receivedAt],
        ['app.dot::r2', r2.receivedAt],
      ]),
    );

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r3' }));
    const openAfter = readOpenAfterUpdate(tracker, store);

    // Then
    expect(openAfter).toEqual(
      new Map([
        ['app.dot::r2', r2.receivedAt],
        ['app.dot::r3', nth(store.list(), 1).receivedAt],
      ]),
    );
  });

  it('As the debug panel, I keep a repeated request and its call is timed from its first kept copy', async () => {
    // Given two copies at distinct times, which only a set clock guarantees
    const timers = createManualTimers({ start: 100 });
    const store = createEventStore({ capacity: 2, timers });
    const tracker = createOpenCallTracker();
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));
    await timers.advance(100);
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));

    // When both copies are kept
    const openBefore = readOpenAfterUpdate(tracker, store);

    // Then
    expect(openBefore).toEqual(new Map([['app.dot::r1', 100]]));

    // When the first copy is evicted
    store.insertDotli(TOPBAR_READY);
    const openAfter = readOpenAfterUpdate(tracker, store);

    // Then
    expect(openAfter).toEqual(new Map([['app.dot::r1', 200]]));
  });

  it('As the debug panel, I clear the events and only calls that arrive after the clear are open', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    const tracker = createOpenCallTracker();
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));
    readOpenAfterUpdate(tracker, store);

    // When
    store.clear();
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r2' }));
    const open = readOpenAfterUpdate(tracker, store);

    // Then
    expect(open).toEqual(new Map([['app.dot::r2', nth(store.list(), 0).receivedAt]]));
  });

  it('As the debug panel, I update over a random walk and the open calls equal a full recompute at each step', () => {
    // Given
    const store = createEventStore({ capacity: 25 });
    const tracker = createOpenCallTracker();
    // A fixed pseudo-random walk: requests, replies, noise and repeats.
    let seed = 7;
    function pickBelow(bound: number): number {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    }

    const tracked: Map<string, number>[] = [];
    const recomputed: Map<string, number>[] = [];

    // When
    for (let frame = 0; frame < 200; frame++) {
      const burst = pickBelow(6);
      for (let index = 0; index < burst; index++) {
        const requestId = `r${String(pickBelow(15))}`;
        const productId = pickBelow(3) === 0 ? null : `p${String(pickBelow(2))}`;
        const tag = nth(WALK_TAGS, pickBelow(WALK_TAGS.length));
        store.insertTruapi(buildTruapiEvent({ tag, requestId, productId }));
      }
      if (frame === 120) {
        store.clear();
      }
      if (frame % 3 === 0) {
        store.insertDotli(TOPBAR_READY);
      }
      const events = store.list().slice();
      tracker.update(events);
      tracked.push(new Map(tracker.open()));
      recomputed.push(computeOpenCalls(events));
    }

    // Then
    expect(tracked).toEqual(recomputed);
  });

  it.each([
    { earlier: [], tag: 'x_request', changed: true },
    { earlier: ['x_request'], tag: 'x_receive', changed: false },
    { earlier: ['x_request', 'x_receive'], tag: 'x_response', changed: true },
  ])(
    'As the debug panel, I update after a $tag and learn whether the open calls changed ($changed)',
    ({ earlier, tag, changed }) => {
      // Given
      const store = createEventStore({ capacity: 10 });
      const tracker = createOpenCallTracker();
      for (const earlierTag of earlier) {
        store.insertTruapi(buildTruapiEvent({ tag: earlierTag, requestId: 'r1' }));
        tracker.update(store.list().slice());
      }

      // When
      store.insertTruapi(buildTruapiEvent({ tag, requestId: 'r1' }));
      const changedOnUpdate = tracker.update(store.list().slice());

      // Then
      expect(changedOnUpdate).toBe(changed);
    },
  );

  it('As the debug panel, I ask twice between two updates and read the same open calls and changed keys', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    const tracker = createOpenCallTracker();
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));
    tracker.update(store.list().slice());

    // When
    const firstOpen = tracker.open();
    const secondOpen = tracker.open();
    const firstChanged = tracker.changedKeys();
    const secondChanged = tracker.changedKeys();

    // Then
    expect(secondOpen).toBe(firstOpen);
    expect(secondChanged).toBe(firstChanged);
  });

  it('As the debug panel, I update twice and read one open-call map changed in place', () => {
    // Given
    const store = createEventStore({ capacity: 10 });
    const tracker = createOpenCallTracker();
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r1' }));
    tracker.update(store.list().slice());
    const before = tracker.open();

    // When
    store.insertTruapi(buildTruapiEvent({ tag: 'x_request', requestId: 'r2' }));
    tracker.update(store.list().slice());
    const after = tracker.open();

    // Then
    expect(after).toBe(before);
    expect([...after.keys()]).toEqual(['app.dot::r1', 'app.dot::r2']);
  });
});
