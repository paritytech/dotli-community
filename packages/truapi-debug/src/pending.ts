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

import type { StoredEvent, StoredTruapiEvent } from "./event-store.ts";

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

/** Elapsed label for a pending badge. Seconds once past a second, because a
 *  four-digit millisecond count is harder to read at a glance than `4.4s`. */
export function formatPending(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
