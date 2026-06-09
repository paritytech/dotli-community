// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug filters
//
// Filter state and predicate. Applied to both TrUAPI and system events.
// Direction and product filters are TrUAPI-specific and are bypassed
// for system events. The tag filter is universal. It matches against the
// TrUAPI method tag for truapi events and against the `layer:event`
// string for system events.

import type { StoredEvent } from "./event-store.ts";

export type DirectionFilter = "both" | "incoming" | "outgoing";

export interface FilterState {
  direction: DirectionFilter;
  /** `undefined` means no product filter. A `null` key matches events with `productId: undefined`. */
  product: string | null | undefined;
  /** Case-insensitive substring match against the event's display tag. */
  tagQuery: string;
  /** Whether TrUAPI (host and product) events are visible. */
  showTruapi: boolean;
  /** Whether System (SDK + dotli-internal) events are visible. */
  showSystem: boolean;
}

export function initialFilterState(): FilterState {
  return {
    direction: "both",
    product: undefined,
    tagQuery: "",
    showTruapi: true,
    showSystem: true,
  };
}

export function matches(ev: StoredEvent, f: FilterState): boolean {
  if (ev.kind === "truapi") {
    if (!f.showTruapi) {
      return false;
    }
    if (f.direction !== "both" && ev.direction !== f.direction) {
      return false;
    }
    if (f.product !== undefined) {
      const want = f.product;
      const got = ev.productId ?? null;
      if (want !== got) {
        return false;
      }
    }
  } else {
    if (!f.showSystem) {
      return false;
    }
    // Direction and product filters don't apply to system events.
  }
  const q = f.tagQuery.trim().toLowerCase();
  if (q === "") {
    return true;
  }
  const haystack = ev.kind === "truapi" ? ev.tag : `${ev.layer}:${ev.event}`;
  return haystack.toLowerCase().includes(q);
}
