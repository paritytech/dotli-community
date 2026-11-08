// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { describe, expect, it } from 'vitest';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { BOOT_STARTED } from '../testing/constants.js';
import { computeGlobalYPositions } from './computeGlobalYPositions.js';
import { computeLayout, type SegmentEntry } from './computeLayout.js';
import { createEventStore } from './createEventStore.js';

/** The timeline box of a host flow that began with a boot start and went on to `end`. */
function layoutFlow(end: DotliDebugEvent): SegmentEntry | undefined {
  const store = createEventStore({ capacity: 10 });
  store.insertDotli(buildSystemEvent(BOOT_STARTED));
  store.insertDotli(end);
  const events = store.list();
  const { entries } = computeLayout(events, computeGlobalYPositions(events));
  return entries.find((entry): entry is SegmentEntry => entry.kind === 'segment');
}

describe('debug panel timeline of host flows', () => {
  it.each<{ story: string; end: DotliDebugEvent; pending: boolean }>([
    {
      story: 'that failed to resolve as finished',
      end: buildSystemEvent({
        layer: 'resolve',
        event: 'failed',
        timestamp: 1,
        payload: { label: 'app', source: 'smoldot', reason: 'no peers' },
      }),
      pending: false,
    },
    {
      story: 'whose last step does not end it as pending',
      end: buildSystemEvent({ layer: 'boot', event: 'topbar_ready', timestamp: 1, payload: {} }),
      pending: true,
    },
    {
      story: 'that reached an event the union does not name as pending',
      // A sandbox of another release sends a name the union lacks.
      end: {
        layer: 'sandbox',
        event: 'archive_failed',
        flowId: 'flow-1',
        timestamp: 1,
        payload: {},
      } as unknown as DotliDebugEvent,
      pending: true,
    },
  ])('As a dotli developer, I see a host flow $story on the timeline', ({ end, pending }) => {
    // Given a host flow that began with a boot start and whose last step is the row's event

    // When the timeline lays the flow out
    const segment = layoutFlow(end);

    // Then its box is pending or finished, as the row says
    expect(segment).toMatchObject({ kind: 'segment', pending });
  });
});
