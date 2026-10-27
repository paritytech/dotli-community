// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A row's latency appears only once its reply lands, so without this a hung call looks like a fast one.
// Scoped to TrUAPI because answering those calls is where the host actually stalls.

import { isResponseTag } from './callTag.js';
import { findFirstNewIndex } from './findFirstNewIndex.js';
import { getCallKey } from './getCallKey.js';
import type { StoredEvent } from './storedEvent.js';

/** The TrUAPI calls still awaiting a reply, followed snapshot by snapshot. */
export type OpenCallTracker = ReturnType<typeof createOpenCallTracker>;

/** Past this a call is called out rather than just counted. */
export const SLOW_AFTER_MS = 3000;

/** Costs in proportion to the events that arrived or left since the last snapshot, not those retained. */
export function createOpenCallTracker() {
  let seen: readonly StoredEvent[] = [];
  // Oldest first.
  const requests = new Map<string, number[]>();
  const replies = new Map<string, number>();
  const openByKey = new Map<string, number>();
  let changed: ReadonlySet<string> = new Set();

  return {
    /**
     * Each call awaiting a reply, mapped to its first retained request time. Absence clears a row's badge. The same
     * map on every call, which `update` changes in place.
     */
    open,
    /** The calls whose entry in `open()` the last `update` changed. The same set on every call until the next `update`. */
    changedKeys,
    /**
     * Follows the store to `events`, which must be a later snapshot of the same store than the last one passed.
     * Returns whether any entry of `open()` changed. Never throws.
     */
    update,
  };

  function open(): ReadonlyMap<string, number> {
    return openByKey;
  }

  function changedKeys(): ReadonlySet<string> {
    return changed;
  }

  function update(events: readonly StoredEvent[]): boolean {
    const previous = seen;
    seen = events;
    const touched = new Set<string>();
    // Events leave only from the head (or all at once on clear), in order.
    const firstSeq = events[0]?.seq ?? Infinity;
    for (const event of previous) {
      if (event.seq >= firstSeq) {
        break;
      }
      if (event.kind !== 'truapi') {
        continue;
      }
      const key = getCallKey(event);
      touched.add(key);
      if (isResponseTag(event.tag)) {
        forgetReply(key);
      } else {
        forgetRequest(key);
      }
    }
    for (let index = findFirstNewIndex(previous, events); index < events.length; index++) {
      const event = events[index];
      if (event?.kind !== 'truapi') {
        continue;
      }
      const key = getCallKey(event);
      touched.add(key);
      if (isResponseTag(event.tag)) {
        replies.set(key, (replies.get(key) ?? 0) + 1);
      } else {
        recordRequest(key, event.receivedAt);
      }
    }
    const nextChanged = new Set<string>();
    for (const key of touched) {
      const since = replies.has(key) ? undefined : requests.get(key)?.[0];
      if (since === openByKey.get(key)) {
        continue;
      }
      nextChanged.add(key);
      if (since === undefined) {
        openByKey.delete(key);
      } else {
        openByKey.set(key, since);
      }
    }
    changed = nextChanged;
    return nextChanged.size > 0;
  }

  function forgetReply(key: string): void {
    const left = (replies.get(key) ?? 1) - 1;
    if (left > 0) {
      replies.set(key, left);
    } else {
      replies.delete(key);
    }
  }

  function forgetRequest(key: string): void {
    const times = requests.get(key);
    times?.shift();
    if (times?.length === 0) {
      requests.delete(key);
    }
  }

  function recordRequest(key: string, receivedAt: number): void {
    const times = requests.get(key);
    if (times === undefined) {
      requests.set(key, [receivedAt]);
      return;
    }
    times.push(receivedAt);
  }
}
