// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Outstanding TrUAPI calls.
//
// A request the host has not answered yet is the one thing the list cannot
// show on its own: the `+Xs` latency beside a row is measured against the
// first event of its group, so it only appears once the reply lands. Until
// then a call that hung for thirty seconds reads exactly like one answered in
// a millisecond.
//
// Scoped to TrUAPI deliberately. These are the calls the host has been asked
// to answer, so answering them means signing, reading chain state, or relaying
// a transaction, which is where the host actually stalls. Host lifecycle
// events are short-lived and already grouped in the timeline.

import {
  firstNewIndex,
  type StoredEvent,
  type StoredTruapiEvent,
} from "./event-store.js";

/** Requests outstanding for longer than this are called out rather than just
 *  counted, so a hung call is findable without reading every row. */
export const SLOW_AFTER_MS = 3000;

/**
 * Group key for a call. `requestId` alone is not unique: it is minted per
 * product, so two products in the same tab can both be on `p:1`.
 */
export function callKeyOf(ev: StoredTruapiEvent): string {
  return `${ev.productId ?? "dotli"}::${ev.requestId}`;
}

/**
 * The key a row should carry a pending badge for, or null if the row is not a
 * request.
 *
 * Paired on the `_request` / `_response` tag suffix rather than on
 * `direction`, because which direction carries the request depends on who
 * initiated the call while the suffix does not.
 */
export function pendingKeyOf(ev: StoredEvent): string | null {
  if (ev.kind !== "truapi" || !ev.tag.endsWith("_request")) {
    return null;
  }
  return callKeyOf(ev);
}

/**
 * Every call still waiting on a reply, mapped to the time its request went
 * out. Absence from this map is what tells a row's badge to disappear.
 */
export function openCalls(events: readonly StoredEvent[]): Map<string, number> {
  const requestedAt = new Map<string, number>();
  const answered = new Set<string>();

  for (const ev of events) {
    if (ev.kind !== "truapi") {
      continue;
    }
    const key = callKeyOf(ev);
    if (ev.tag.endsWith("_response")) {
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

/**
 * `openCalls`, kept up to date from successive snapshots of one event store
 * at a cost proportional to the events that arrived or left since the last
 * snapshot, not to the events retained.
 */
export class OpenCallTracker {
  private seen: readonly StoredEvent[] = [];
  /** Receive times of the retained non-reply events per call, oldest first. */
  private readonly requests = new Map<string, number[]>();
  /** Retained replies per call. */
  private readonly replies = new Map<string, number>();
  private readonly openByKey = new Map<string, number>();
  private changed: ReadonlySet<string> = new Set();

  /** Every call still waiting on a reply, as `openCalls` returns it. */
  get open(): ReadonlyMap<string, number> {
    return this.openByKey;
  }

  /** Calls whose entry in `open` was added, moved or removed by the last
   *  `update`. */
  get changedKeys(): ReadonlySet<string> {
    return this.changed;
  }

  /**
   * Catch up with `events`, a later snapshot of the same store than the last
   * one passed. Returns whether the open calls changed.
   */
  update(events: readonly StoredEvent[]): boolean {
    const prev = this.seen;
    this.seen = events;
    const touched = new Set<string>();
    // Events leave only from the head (or all at once on clear), in order.
    const firstSeq = events.length > 0 ? events[0].seq : Infinity;
    for (let i = 0; i < prev.length && prev[i].seq < firstSeq; i++) {
      const ev = prev[i];
      if (ev.kind !== "truapi") {
        continue;
      }
      const key = callKeyOf(ev);
      touched.add(key);
      if (ev.tag.endsWith("_response")) {
        const left = (this.replies.get(key) ?? 1) - 1;
        if (left > 0) {
          this.replies.set(key, left);
        } else {
          this.replies.delete(key);
        }
      } else {
        const times = this.requests.get(key);
        times?.shift();
        if (times?.length === 0) {
          this.requests.delete(key);
        }
      }
    }
    for (let i = firstNewIndex(prev, events); i < events.length; i++) {
      const ev = events[i];
      if (ev.kind !== "truapi") {
        continue;
      }
      const key = callKeyOf(ev);
      touched.add(key);
      if (ev.tag.endsWith("_response")) {
        this.replies.set(key, (this.replies.get(key) ?? 0) + 1);
      } else {
        const times = this.requests.get(key);
        if (times === undefined) {
          this.requests.set(key, [ev.receivedAt]);
        } else {
          times.push(ev.receivedAt);
        }
      }
    }
    const changed = new Set<string>();
    for (const key of touched) {
      const since = this.replies.has(key)
        ? undefined
        : this.requests.get(key)?.[0];
      if (since === this.openByKey.get(key)) {
        continue;
      }
      changed.add(key);
      if (since === undefined) {
        this.openByKey.delete(key);
      } else {
        this.openByKey.set(key, since);
      }
    }
    this.changed = changed;
    return changed.size > 0;
  }
}

/** Elapsed label for a pending badge. Seconds once past a second, because a
 *  four-digit millisecond count is harder to read at a glance than `4.4s`. */
export function formatPending(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
