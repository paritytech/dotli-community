// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { findFirstNewIndex } from './findFirstNewIndex.js';
import type { StoredEvent } from './storedEvent.js';

type Params<Event> = {
  /** The visible list the last update returned. */
  previous: readonly Event[];
  /** The snapshot's events at the last update. */
  lastEvents: readonly Event[];
  /** The snapshot's events now. */
  events: readonly Event[];
  /** Whether an event passes the filters both updates applied. */
  passes: (event: Event) => boolean;
};

/**
 * The visible list after the store evicted or appended events under the same filters: `previous` without the evicted
 * events, followed by the new events that pass the filters. Returns `previous` itself when nothing was evicted or
 * added, so the list keeps its identity. Never throws.
 */
export function appendVisible<Event extends Pick<StoredEvent, 'seq'>>({
  previous,
  lastEvents,
  events,
  passes,
}: Params<Event>): readonly Event[] {
  // Events leave the store only from the head.
  const firstSeq = events[0]?.seq ?? Infinity;
  const kept = previous.findIndex(e => e.seq >= firstSeq);
  const dropped = kept === -1 ? previous.length : kept;
  const added = events.slice(findFirstNewIndex(lastEvents, events)).filter(passes);
  if (dropped === 0 && added.length === 0) {
    return previous;
  }
  return [...previous.slice(dropped), ...added];
}
