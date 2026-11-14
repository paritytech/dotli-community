// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { LabelStoreCursor } from '@dotli/resolver';
import type { NameListRecord } from '@dotli/storage';
import { createNameListTrace } from './createNameListTrace.js';
import { NAME_LIST_MARKS } from './nameListTimeline.js';
import type { NameListReads } from './syncNameList.js';

type TimelineEntry = { type: 'mark' | 'measure'; name: string; detail: unknown };

describe('createNameListTrace', () => {
  it('As a visitor with a stored list, I sync it and the trace marks each phase in order and ends with the work it did', async () => {
    // Given: a stored list of 2 stores and 1 app, and reads that add a store, move two cursors and find one app
    const { entries, timeline, now } = createFakeTimeline();
    const trace = createNameListTrace({ backend: 'rpc-gateway', timeline, now });
    const stored: NameListRecord = {
      network: 'paseo-next-v2',
      stores: [
        { address: 'store-1', read: 4 },
        { address: 'store-2', read: 1 },
      ],
      apps: ['known'],
      pending: [],
    };
    const reads = trace.withReads(
      createFakeReads({
        readLabelStores: () => Promise.resolve(['store-3']),
        readNewLabels: stores =>
          Promise.resolve({
            stores: stores.map((store, index) => ({ ...store, read: store.read + (index === 0 ? 3 : 2) })),
            labels: ['a', 'b'],
          }),
        readAppLabels: () => Promise.resolve(new Set(['a'])),
      }),
    );

    // When
    trace.storedRead(stored);
    trace.readsOpened();
    trace.labelsShown(0);
    trace.labelsShown(1);
    trace.labelsShown(2);
    await reads.readAppLabels([]);
    await reads.readLabelStores(2);
    await reads.readNewLabels(stored.stores);
    await reads.readAppLabels(['a', 'b']);
    trace.ended({ kind: 'ok' });

    // Then
    expect(entries.filter(e => e.type === 'mark').map(e => e.name)).toEqual([
      NAME_LIST_MARKS.start,
      NAME_LIST_MARKS.stored,
      NAME_LIST_MARKS.reads,
      NAME_LIST_MARKS.labels,
      NAME_LIST_MARKS.end,
    ]);
    expect(entries.filter(e => e.type === 'measure')).toHaveLength(3);
    expect(entries.find(e => e.name === NAME_LIST_MARKS.end)?.detail).toEqual({
      outcome: 'ok',
      reason: null,
      backend: 'rpc-gateway',
      start: 'stored',
      stores: 3,
      entries: 5,
      labels: 2,
      apps: 1,
      reads: 3,
    });
  });

  it('As a visitor whose read fails, I get the same error and the trace measures the read as failed', async () => {
    // Given: a store read that rejects
    const { entries, timeline, now } = createFakeTimeline();
    const trace = createNameListTrace({ backend: 'rpc-gateway', timeline, now });
    const failure = new Error('read failed');
    const reads = trace.withReads(createFakeReads({ readNewLabels: () => Promise.reject(failure) }));

    // When
    const read = reads.readNewLabels([{ address: 'store-1', read: 0 }]);

    // Then
    await expect(read).rejects.toBe(failure);
    expect(entries.find(e => e.type === 'measure')?.detail).toEqual({
      kind: 'new_labels',
      outcome: 'error',
      items: 1,
      found: 0,
    });
  });

  it('As a visitor whose sync fails, I end its trace twice and one end mark names the error', () => {
    // Given
    const { entries, timeline, now } = createFakeTimeline();
    const trace = createNameListTrace({ backend: 'rpc-gateway', timeline, now });

    // When
    trace.ended({ kind: 'error', error: new TypeError('sync failed') });
    trace.ended({ kind: 'ok' });

    // Then
    const ends = entries.filter(e => e.name === NAME_LIST_MARKS.end);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.detail).toMatchObject({ outcome: 'error', reason: 'TypeError' });
  });
});

/** A timeline that records each mark and measure in order, on a clock that ticks once per call. */
function createFakeTimeline() {
  const entries: TimelineEntry[] = [];
  let tick = 0;
  return {
    entries,
    timeline: {
      mark: (name: string, { detail }: { detail: unknown }) => {
        entries.push({ type: 'mark', name, detail });
      },
      measure: (name: string, { detail }: { detail: unknown }) => {
        entries.push({ type: 'measure', name, detail });
      },
    },
    now: () => (tick += 1),
  };
}

/** Reads that answer with what `overrides` gives, and with nothing found otherwise. */
function createFakeReads(overrides: Partial<NameListReads>): NameListReads {
  return {
    readLabelStores: () => Promise.resolve([]),
    readNewLabels: (stores: readonly LabelStoreCursor[]) => Promise.resolve({ stores: [...stores], labels: [] }),
    readAppLabels: () => Promise.resolve(new Set()),
    ...overrides,
  };
}
