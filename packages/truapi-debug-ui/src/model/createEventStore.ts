// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Events are never mutated after insertion.

import { atom, type ReadableAtom } from 'nanostores';
import { realTimers, type Timers } from '@dotli/shared';
import type { DotliDebugEvent, TruapiDebugMessageEvent } from '@dotli/truapi-debug';
import { isRequestTag, isResponseTag } from './callTag.js';
import { getCallKey } from './getCallKey.js';
import { getCorrelationKey } from './getCorrelationKey.js';
import { toSystemEventPair } from './getSystemEventKey.js';
import type { EventSeq, StoredEvent, StoredSystemEvent, StoredTruapiEvent } from './storedEvent.js';

/** The panel's ring of captured events, with the groups, products and open calls it keeps for them. */
export type EventStore = ReturnType<typeof createEventStore>;

type Params = {
  /** The most events the ring keeps. Past it the oldest is evicted. */
  capacity: number;
  /** The clock a TrUAPI event's `receivedAt` reads at insert. */
  timers?: Pick<Timers, 'now'>;
};

type AddToCountParams<Key> = {
  key: Key;
  /** Added to the count, negative to take away. */
  step: number;
};

/** A ring of `capacity` events that bumps its version on each change. */
export function createEventStore({ capacity, timers = realTimers }: Params) {
  const ring: StoredEvent[] = [];
  let paused = false;
  let nextSeq = 0;
  let droppedCount = 0;
  const firstByKey = new Map<string, StoredEvent>();
  const anchors = new WeakMap<StoredEvent, StoredEvent>();
  // Kept so `productIds()` needs no scan.
  const productCounts = new Map<string | undefined, number>();
  // Requests kept and not yet answered, by call key. A paused store still takes the one reply that closes each, so it
  // holds at most as many entries as the ring holds requests.
  const unanswered = new Map<string, number>();
  const versionAtom = atom(0);
  const version: ReadableAtom<number> = versionAtom;

  return {
    /** The most events the ring keeps. */
    capacity,
    /** How many events the ring evicted since it was made or last cleared. Never throws. */
    dropped,
    /**
     * Pauses or resumes recording. A change bumps the version, and a repeat of the current state does nothing.
     * Never throws while the version's followers keep their rule.
     */
    setPaused,
    /** Whether recording is paused. Never throws. */
    isPaused,
    /**
     * Drops every kept event and the dropped count, then bumps the version. Never throws while the version's followers
     * keep their rule.
     */
    clear,
    /**
     * Keeps a TrUAPI message, stamped with the clock at insert. While paused it keeps only the reply that closes a call
     * whose request the ring still holds. Never throws while the version's followers keep their rule.
     */
    insertTruapi,
    /**
     * Keeps a host event under its own timestamp. Does nothing while paused. Never throws while the version's followers
     * keep their rule.
     */
    insertDotli,
    /** The kept events, oldest first. The live ring, so a caller that holds on to it copies it first. Never throws. */
    list,
    /** The oldest kept event of the group `key`, or undefined when the ring keeps none of it. Never throws. */
    firstInGroup,
    /**
     * The group's first event as it stood when `event` was inserted, undefined when `event` opened the group.
     * Unlike `firstInGroup`, it survives the anchor's eviction, so a row's latency never depends on when it was drawn.
     * Never throws.
     */
    anchorOf,
    /** The kept event numbered `seq`, or undefined once it is evicted. A scan of the ring, O(N). Never throws. */
    getBySeq,
    /** A new array of the kept events of the group `key`, oldest first. Never throws. */
    eventsInGroup,
    /** A new array of each product id the kept TrUAPI events carry, once, `undefined` among them. Never throws. */
    productIds,
    /**
     * Counts the changes, one per change and never rewound, so a consumer can snapshot `list()` by comparing versions
     * instead of diffing. A follower runs inside the change that bumps it, so it must not throw. `get` never throws.
     */
    version,
  };

  function dropped(): number {
    return droppedCount;
  }

  function setPaused(next: boolean): void {
    if (paused === next) {
      return;
    }
    paused = next;
    notify();
  }

  function isPaused(): boolean {
    return paused;
  }

  function clear(): void {
    ring.length = 0;
    firstByKey.clear();
    productCounts.clear();
    unanswered.clear();
    droppedCount = 0;
    notify();
  }

  function insertTruapi(event: TruapiDebugMessageEvent): void {
    // Without its reply, a call recorded before Pause would read pending for good once the panel resumes.
    if (paused && !(isResponseTag(event.payload.tag) && unanswered.has(getCallKey(event)))) {
      return;
    }
    const stored: StoredTruapiEvent = {
      kind: 'truapi',
      seq: nextSeq++,
      receivedAt: timers.now(),
      direction: event.direction,
      productId: event.productId,
      requestId: event.requestId,
      tag: event.payload.tag,
      payload: event.payload.value,
    };
    pushAndEvict(stored);
  }

  function insertDotli(event: DotliDebugEvent): void {
    if (paused) {
      return;
    }
    const stored: StoredSystemEvent = {
      kind: 'system',
      seq: nextSeq++,
      receivedAt: event.timestamp,
      source: 'dotli',
      ...toSystemEventPair(event),
      flowId: event.flowId,
      payload: event.payload,
    };
    pushAndEvict(stored);
  }

  function list(): readonly StoredEvent[] {
    return ring;
  }

  function firstInGroup(key: string): StoredEvent | undefined {
    return firstByKey.get(key);
  }

  function anchorOf(event: StoredEvent): StoredEvent | undefined {
    return anchors.get(event);
  }

  function getBySeq(seq: EventSeq): StoredEvent | undefined {
    for (let index = ring.length - 1; index >= 0; index--) {
      const event = ring[index];
      if (event?.seq === seq) {
        return event;
      }
    }
    return undefined;
  }

  function eventsInGroup(key: string): StoredEvent[] {
    const grouped: StoredEvent[] = [];
    for (const event of ring) {
      if (getCorrelationKey(event) === key) {
        grouped.push(event);
      }
    }
    return grouped;
  }

  function productIds(): (string | undefined)[] {
    return Array.from(productCounts.keys());
  }

  function pushAndEvict(stored: StoredEvent): void {
    ring.push(stored);
    const key = getCorrelationKey(stored);
    const anchor = firstByKey.get(key);
    if (anchor === undefined) {
      firstByKey.set(key, stored);
    } else {
      anchors.set(stored, anchor);
    }
    countProduct(stored, 1);
    trackCall(stored, 1);
    while (ring.length > capacity) {
      const evicted = ring.shift();
      droppedCount++;
      if (evicted === undefined) {
        continue;
      }
      const evictedKey = getCorrelationKey(evicted);
      const head = firstByKey.get(evictedKey);
      if (head?.seq === evicted.seq) {
        firstByKey.delete(evictedKey);
      }
      countProduct(evicted, -1);
      trackCall(evicted, -1);
    }
    notify();
  }

  function countProduct(event: StoredEvent, delta: 1 | -1): void {
    if (event.kind !== 'truapi') {
      return;
    }
    addToCount(productCounts, { key: event.productId, step: delta });
  }

  /** A kept request opens its call, its reply closes it, and an evicted request leaves nothing to close. */
  function trackCall(event: StoredEvent, delta: 1 | -1): void {
    if (event.kind !== 'truapi') {
      return;
    }
    let step = 0;
    if (isRequestTag(event.tag)) {
      step = delta;
    } else if (isResponseTag(event.tag) && delta === 1) {
      step = -1;
    }
    if (step === 0) {
      return;
    }
    addToCount(unanswered, { key: getCallKey(event), step });
  }

  /** Adds `step` to the count of `key`, and drops the key once its count reaches zero. CAUTION: writes into `counts`. */
  function addToCount<Key>(counts: Map<Key, number>, { key, step }: AddToCountParams<Key>): void {
    const next = (counts.get(key) ?? 0) + step;
    if (next > 0) {
      counts.set(key, next);
    } else {
      counts.delete(key);
    }
  }

  function notify(): void {
    versionAtom.set(versionAtom.get() + 1);
  }
}
