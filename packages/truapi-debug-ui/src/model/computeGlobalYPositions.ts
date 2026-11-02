// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { EventSeq, StoredEvent } from './storedEvent.js';
import { ROW_HEIGHT } from './timelineGeometry.js';

export type GlobalYPositions = {
  /** Each event's row Y, by its seq. */
  seqToY: Map<EventSeq, number>;
  /** The height of every row together, never less than one row. */
  totalHeight: number;
};

/** Each event's row Y, one row per event in order. Shared across swimlanes so boxes at the same Y are the same moment. */
export function computeGlobalYPositions(events: readonly StoredEvent[]): GlobalYPositions {
  const seqToY = new Map<EventSeq, number>();
  for (const [index, event] of events.entries()) {
    seqToY.set(event.seq, index * ROW_HEIGHT);
  }
  const totalHeight = Math.max(1, events.length) * ROW_HEIGHT;
  return { seqToY, totalHeight };
}
