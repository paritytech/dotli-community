// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A row's latency appears only once its reply lands, so without this a hung call looks like a fast one.
// Scoped to TrUAPI because answering those calls is where the host actually stalls.

import { firstNewIndex, type StoredEvent, type StoredTruapiEvent } from './event-store.js';

/** Past this a call is called out rather than just counted. */
export const SLOW_AFTER_MS = 3000;

/** `requestId` is minted per product, so two products in one tab can share it. */
export function callKeyOf(ev: StoredTruapiEvent): string {
  return `${ev.productId ?? 'dotli'}::${ev.requestId}`;
}

/** Paired on the tag suffix, not `direction`, which depends on who initiated the call. */
export function pendingKeyOf(ev: StoredEvent): string | null {
  if (ev.kind !== 'truapi' || !ev.tag.endsWith('_request')) {
    return null;
  }
  return callKeyOf(ev);
}

/** Costs in proportion to the events that arrived or left since the last snapshot, not those retained. */
export class OpenCallTracker {
  private seen: readonly StoredEvent[] = [];
  /** Oldest first. */
  private readonly requests = new Map<string, number[]>();
  private readonly replies = new Map<string, number>();
  private readonly openByKey = new Map<string, number>();
  private changed: ReadonlySet<string> = new Set();

  /** Each call awaiting a reply, mapped to its first retained request time. Absence clears a row's badge. */
  get open(): ReadonlyMap<string, number> {
    return this.openByKey;
  }

  get changedKeys(): ReadonlySet<string> {
    return this.changed;
  }

  /** `events` must be a later snapshot of the same store than the last one passed. */
  update(events: readonly StoredEvent[]): boolean {
    const prev = this.seen;
    this.seen = events;
    const touched = new Set<string>();
    // Events leave only from the head (or all at once on clear), in order.
    const firstSeq = events[0]?.seq ?? Infinity;
    for (const ev of prev) {
      if (ev.seq >= firstSeq) {
        break;
      }
      if (ev.kind !== 'truapi') {
        continue;
      }
      const key = callKeyOf(ev);
      touched.add(key);
      if (ev.tag.endsWith('_response')) {
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
      if (ev?.kind !== 'truapi') {
        continue;
      }
      const key = callKeyOf(ev);
      touched.add(key);
      if (ev.tag.endsWith('_response')) {
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
      const since = this.replies.has(key) ? undefined : this.requests.get(key)?.[0];
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

export function formatPending(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
