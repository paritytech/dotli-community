// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs the landing page's name list sync on each backend, from an empty profile and then from the stored list, and
// prints its timings from the page's performance timeline. Nothing is written to disk.
//
// Usage:
//   npm run test:perf:names
//   PERF_RUNS=3 PERF_BACKENDS=rpc-gateway,smoldot-direct npm run test:perf:names
//   PERF_NAME_LIST_TIMEOUT_MS=600000 npm run test:perf:names

import { errors, expect, type Browser, type Page } from '@playwright/test';
import { getErrorName } from '@dotli/shared';
import {
  isNameListReadDetail,
  isNameListSyncSummary,
  NAME_LIST_MARKS,
  NAME_LIST_READ_KINDS,
  NAME_LIST_READ_MEASURE,
  type NameListReadDetail,
  type NameListSyncSummary,
} from '../../src/nameListTimeline.js';
import { PORT } from '../env.js';
import { BACKENDS, type Backend } from '../functional/fixtures/settings.js';
import { setupTest } from '../functional/helpers/context.js';
import { test } from '../functional/helpers/sharedModeReset.js';

type Step = 'cold' | 'stored';

type SyncTimeline = {
  summary: NameListSyncSummary;
  marks: { name: string; startTime: number }[];
  reads: { detail: NameListReadDetail; duration: number }[];
};

/** A timeline as the page hands it over, before its details are checked. */
type RecordedTimeline = {
  summary: unknown;
  marks: SyncTimeline['marks'];
  reads: { detail: unknown; duration: number }[];
};

type Settled<Value> = { kind: 'ok'; value: Value } | { kind: 'failed'; error: unknown };

const RUNS = parseInt(process.env['PERF_RUNS'] ?? '1', 10);
const SYNC_TIMEOUT_MS = parseInt(process.env['PERF_NAME_LIST_TIMEOUT_MS'] ?? '300000', 10);
const SELECTED_BACKENDS = readBackends(process.env['PERF_BACKENDS']);

const COLUMNS: readonly { title: string; width: number }[] = [
  { title: 'backend', width: 22 },
  { title: 'step', width: 7 },
  { title: 'run', width: 4 },
  { title: 'outcome', width: 32 },
  { title: 't_stored', width: 8 },
  { title: 't_reads', width: 8 },
  { title: 't_labels', width: 8 },
  { title: 't_total', width: 8 },
  ...NAME_LIST_READ_KINDS.map(kind => ({ title: kind, width: 13 })),
  { title: 'n_entries', width: 9 },
  { title: 'n_labels', width: 8 },
  { title: 'n_apps', width: 6 },
  { title: 'n_reads', width: 7 },
];

for (const backend of SELECTED_BACKENDS) {
  test(`As a dotli maintainer, I run the landing name list sync via ${backend} and its timings are printed`, async ({
    browser,
  }) => {
    // Given
    test.setTimeout(RUNS * 2 * SYNC_TIMEOUT_MS + 60_000);

    // When
    console.log(
      `\n  Name list sync via ${backend}. Times are seconds from the start mark, read times summed per kind.`,
    );
    printRow(COLUMNS.map(column => column.title));
    let rows = 0;
    for (let run = 1; run <= RUNS; run++) {
      rows += await measureIteration(browser, backend, run);
    }

    // Then
    expect(rows).toBeGreaterThan(0);
  });
}

/** Runs one cold and one stored sync in a fresh profile, prints a row for each, and answers how many it printed. */
async function measureIteration(browser: Browser, backend: Backend, run: number): Promise<number> {
  const setup = await settle(() => setupTest(browser, { backend }));
  if (setup.kind === 'failed') {
    printFailure([backend, 'cold', String(run)], setup.error);
    return 1;
  }
  const { context, page } = setup.value;
  try {
    const cold = await settle(async () => {
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'commit' });
      return readSyncTimeline(page);
    });
    printStep([backend, 'cold', String(run)], cold);
    if (cold.kind === 'failed') {
      return 1;
    }
    const stored = await settle(async () => {
      await page.reload({ waitUntil: 'commit' });
      return readSyncTimeline(page);
    });
    printStep([backend, 'stored', String(run)], stored);
    return 2;
  } finally {
    try {
      await context.close();
    } catch (error) {
      console.log(`  Closing the ${backend} context of run ${String(run)} failed: ${describeError(error)}`);
    }
  }
}

/**
 * Waits for the sync's end mark, then reads its marks and read measures. Rejects with a `TimeoutError` past the limit,
 * and with an `Error` when the end mark is gone by the time it reads or a detail is not the expected shape.
 */
async function readSyncTimeline(page: Page): Promise<SyncTimeline> {
  // The page functions run in the page, where no module binding exists, so every name goes in as their argument.
  await page.waitForFunction(name => performance.getEntriesByName(name, 'mark').length > 0, NAME_LIST_MARKS.end, {
    polling: 500,
    timeout: SYNC_TIMEOUT_MS,
  });
  const recorded = await page.evaluate(
    ({ end, markNames, measure }): RecordedTimeline => ({
      summary: performance.getEntriesByName(end, 'mark').find(entry => entry instanceof PerformanceMark)?.detail,
      marks: markNames.flatMap(name =>
        performance
          .getEntriesByName(name, 'mark')
          .slice(0, 1)
          .map(mark => ({ name, startTime: mark.startTime })),
      ),
      reads: performance
        .getEntriesByName(measure, 'measure')
        .filter(entry => entry instanceof PerformanceMeasure)
        .map((entry): RecordedTimeline['reads'][number] => ({ detail: entry.detail, duration: entry.duration })),
    }),
    { end: NAME_LIST_MARKS.end, markNames: Object.values(NAME_LIST_MARKS), measure: NAME_LIST_READ_MEASURE },
  );
  // The host can reload itself between the wait and this read, and the new document has no end mark yet.
  const { summary } = recorded;
  if (!isNameListSyncSummary(summary)) {
    throw new Error(`The name list end mark '${NAME_LIST_MARKS.end}' held no sync summary after the wait`);
  }
  const reads = recorded.reads.map(({ detail, duration }) => {
    if (!isNameListReadDetail(detail)) {
      throw new Error(`A '${NAME_LIST_READ_MEASURE}' measure held no read detail`);
    }
    return { detail, duration };
  });
  return { summary, marks: recorded.marks, reads };
}

function printStep(leading: [Backend, Step, string], step: Settled<SyncTimeline>): void {
  if (step.kind === 'failed') {
    printFailure(leading, step.error);
    return;
  }
  const { summary, marks, reads } = step.value;
  const at = new Map(marks.map(mark => [mark.name, mark.startTime]));
  const start = at.get(NAME_LIST_MARKS.start);
  const since = (name: string) => {
    const time = at.get(name);
    return start === undefined || time === undefined ? '-' : formatSeconds(time - start);
  };
  const readTimes = NAME_LIST_READ_KINDS.map(kind => {
    const durations = reads.filter(read => read.detail.kind === kind).map(read => read.duration);
    return durations.length === 0 ? '-' : formatSeconds(durations.reduce((sum, duration) => sum + duration, 0));
  });
  printRow([
    ...leading,
    describeOutcome(summary, leading),
    since(NAME_LIST_MARKS.stored),
    since(NAME_LIST_MARKS.reads),
    since(NAME_LIST_MARKS.labels),
    since(NAME_LIST_MARKS.end),
    ...readTimes,
    String(summary.entries),
    String(summary.labels),
    String(summary.apps),
    String(summary.reads),
  ]);
}

function printFailure(leading: [Backend, Step, string], error: unknown): void {
  const outcome = error instanceof errors.TimeoutError ? 'timeout' : (getErrorName(error) ?? 'unknown');
  printRow([...leading, outcome, ...Array.from({ length: COLUMNS.length - leading.length - 1 }, () => '-')]);
  if (error instanceof Error) {
    console.log(`    ${describeError(error)}`);
  }
}

function printRow(cells: readonly string[]): void {
  console.log(
    `  ${cells.map((cell, index) => cell.slice(0, COLUMNS[index]?.width).padEnd(COLUMNS[index]?.width ?? 0)).join(' ')}`,
  );
}

/** The summary's outcome, or the backend and start it ran on when they are not the ones its row names. */
function describeOutcome(summary: NameListSyncSummary, [backend, step]: [Backend, Step, string]): string {
  if (summary.backend !== backend || summary.start !== step) {
    return `ran ${summary.backend} ${summary.start}`;
  }
  switch (summary.outcome) {
    case 'ok':
      return 'ok';
    case 'error':
      return summary.reason ?? 'unknown';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** A step that fails prints its row instead of failing the test, so the other rows still print. */
async function settle<Value>(work: () => Promise<Value>): Promise<Settled<Value>> {
  try {
    return { kind: 'ok', value: await work() };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

/** Throws an `Error` naming a backend that is not one of `BACKENDS`, or that the list repeats. */
function readBackends(raw: string | undefined): readonly Backend[] {
  if (raw === undefined) {
    return BACKENDS;
  }
  const names = raw.split(',').map(name => name.trim());
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw new Error(`Backend '${repeated}' repeats in PERF_BACKENDS`);
  }
  return names.map(name => {
    const backend = BACKENDS.find(known => known === name);
    if (backend === undefined) {
      throw new Error(`Unknown backend '${name}' in PERF_BACKENDS, expected one of ${BACKENDS.join(', ')}`);
    }
    return backend;
  });
}
