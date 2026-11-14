// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes one landing name list sync to the page's performance timeline: a mark per phase, a measure per resolver read,
// and an end mark that carries what the sync did, so a browser test can wait on the sync and time it.

import type { Backend } from '@dotli/config';
import { getErrorName } from '@dotli/shared';
import type { NameListRecord } from '@dotli/storage';
import {
  NAME_LIST_MARKS,
  NAME_LIST_READ_MEASURE,
  type NameListReadDetail,
  type NameListSyncSummary,
} from './nameListTimeline.js';
import { readPageClock } from './readPageClock.js';
import type { NameListReads } from './syncNameList.js';

type Params = {
  backend: Backend;
  /** Where marks and measures go, the page's performance timeline by default. */
  timeline?: {
    mark: (name: string, options: { detail: unknown }) => unknown;
    measure: (name: string, options: { start: number; end: number; detail: NameListReadDetail }) => unknown;
  };
  /** The page's monotonic clock, `readPageClock` by default. */
  now?: () => number;
};

/** How a sync ended. */
export type NameListTraceEnd = { kind: 'ok' } | { kind: 'error'; error: unknown };

/** Opens the trace of one name list sync on `backend` and marks its start. */
export function createNameListTrace({ backend, timeline = performance, now = readPageClock }: Params) {
  let start: NameListSyncSummary['start'] = 'cold';
  let stores = 0;
  let entries = 0;
  let labels = 0;
  let apps = 0;
  let reads = 0;
  let labelsMarked = false;
  let ended = false;

  timeline.mark(NAME_LIST_MARKS.start, { detail: null });

  return {
    /** Marks the stored list read, `null` on a first visit, which decides whether the sync starts cold. */
    storedRead(record: NameListRecord | null): void {
      timeline.mark(NAME_LIST_MARKS.stored, { detail: null });
      start = record === null ? 'cold' : 'stored';
      stores = record?.stores.length ?? 0;
    },
    /** Marks the resolver's reads ready. */
    readsOpened(): void {
      timeline.mark(NAME_LIST_MARKS.reads, { detail: null });
    },
    /** Marks the first time any label is shown. A later call does nothing. */
    labelsShown(count: number): void {
      if (labelsMarked || count === 0) {
        return;
      }
      labelsMarked = true;
      timeline.mark(NAME_LIST_MARKS.labels, { detail: null });
    },
    /**
     * Wraps `source`, so each read is measured and counted. A wrapped read resolves to the read's own result and
     * rejects with the read's own error. A check of no labels is passed through unmeasured.
     */
    withReads(source: NameListReads): NameListReads {
      return {
        readLabelStores: (known, options) =>
          measureRead(
            { kind: 'label_stores', items: known },
            () => source.readLabelStores(known, options),
            added => {
              stores += added.length;
              return added.length;
            },
          ),
        readNewLabels: (asked, options) =>
          measureRead(
            { kind: 'new_labels', items: asked.length },
            () => source.readNewLabels(asked, options),
            result => {
              const read = result.stores.reduce((sum, store, index) => sum + store.read - (asked[index]?.read ?? 0), 0);
              entries += read;
              labels += result.labels.length;
              return read;
            },
          ),
        readAppLabels: (checked, options) => {
          if (checked.length === 0) {
            return source.readAppLabels(checked, options);
          }
          return measureRead(
            { kind: 'app_labels', items: checked.length },
            () => source.readAppLabels(checked, options),
            withApp => {
              apps += withApp.size;
              return withApp.size;
            },
          );
        },
      };
    },
    /** Marks the sync's end with what it did. Calling it again does nothing. */
    ended(end: NameListTraceEnd): void {
      if (ended) {
        return;
      }
      ended = true;
      const detail: NameListSyncSummary = {
        outcome: end.kind,
        reason: end.kind === 'ok' ? null : (getErrorName(end.error) ?? 'unknown'),
        backend,
        start,
        stores,
        entries,
        labels,
        apps,
        reads,
      };
      timeline.mark(NAME_LIST_MARKS.end, { detail });
    },
  };

  /**
   * Runs `read`, measures it from its start to its settling, and counts what `count` finds in its result. Rejects with
   * the read's own error.
   */
  async function measureRead<Result>(
    { kind, items }: Pick<NameListReadDetail, 'kind' | 'items'>,
    read: () => Promise<Result>,
    count: (result: Result) => number,
  ): Promise<Result> {
    const startedAt = now();
    reads += 1;
    let result: Result;
    try {
      result = await read();
    } catch (error) {
      timeline.measure(NAME_LIST_READ_MEASURE, {
        start: startedAt,
        end: now(),
        detail: { kind, outcome: 'error', items, found: 0 },
      });
      throw error;
    }
    const found = count(result);
    timeline.measure(NAME_LIST_READ_MEASURE, {
      start: startedAt,
      end: now(),
      detail: { kind, outcome: 'ok', items, found },
    });
    return result;
  }
}

/** The trace of one name list sync, as its factory builds it. */
export type NameListTrace = ReturnType<typeof createNameListTrace>;
