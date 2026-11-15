// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { appendVisible } from './appendVisible.js';

type Event = { seq: number };

function buildEvents(...seqs: number[]): Event[] {
  return seqs.map(seq => ({ seq }));
}

function isEven(event: Event): boolean {
  return event.seq % 2 === 0;
}

describe('appendVisible()', () => {
  it("As the debug panel's list, I get a frame with nothing evicted or added and keep the same visible list", () => {
    // Given
    const events = buildEvents(0, 1, 2);
    const previous = events.filter(isEven);

    // When
    const visible = appendVisible({ previous, lastEvents: events, events: events.slice(), passes: isEven });

    // Then
    expect(visible).toBe(previous);
  });

  it("As the debug panel's list, I get a frame that evicts from the head and adds events, and drop the evicted rows and append only the new events that pass", () => {
    // Given
    const lastEvents = buildEvents(0, 1, 2, 3);
    const previous = lastEvents.filter(isEven);

    // When
    const visible = appendVisible({ previous, lastEvents, events: buildEvents(2, 3, 4, 5, 6), passes: isEven });

    // Then
    expect(visible).toEqual(buildEvents(2, 4, 6));
  });

  it("As the debug panel's list, I get a frame after a clear and drop every row", () => {
    // Given
    const lastEvents = buildEvents(0, 1, 2);

    // When
    const visible = appendVisible({ previous: lastEvents, lastEvents, events: [], passes: isEven });

    // Then
    expect(visible).toEqual([]);
  });
});
