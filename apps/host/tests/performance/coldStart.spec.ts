// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Usage:
//   npm run test:perf                run N iterations, save to last.json
//   npm run test:perf:base           save as base.json
//   npm run test:perf:compare        diff base against last
//   PERF_RUNS=15 npm run test:perf   override the iteration count

import { test, expect, errors, type Browser, type Frame, type Page, type Response } from '@playwright/test';
import * as ss from 'simple-statistics';
import * as fs from 'node:fs';
import { findAppFrame } from '../productFrame.js';
import {
  BASE_FILE,
  LAST_FILE,
  NOISY_CV,
  PHASES,
  indentPhase,
  TOTAL_PHASE,
  VERY_NOISY_CV,
  fmt,
  fmtDelta,
  loadResults,
  saveResults,
  type PhaseStats,
  type RunKind,
  type RunStats,
  type SavedResults,
} from './results.js';

type PerfMark = {
  name: string;
  startTime: number;
};

type SingleRun = {
  /** Each measured phase's duration, by its label. */
  phases: Map<string, number>;
  domContentLoaded: number;
  jsHeapUsed: number;
  requestCount: number;
  totalBytes: number;
};

const SAVE_AS_BASE = process.env['PERF_SAVE_BASE'] === '1';
const NUM_RUNS = parseInt(process.env['PERF_RUNS'] ?? '10', 10);
const DOMAIN_A = process.env['PERF_DOMAIN_A'] ?? 'browse';
const DOMAIN_B = process.env['PERF_DOMAIN_B'] ?? 'host-playground';
const PORT = process.env['PERF_PORT'] ?? '5173';
const PERF_VERBOSE = process.env['PERF_VERBOSE'] === '1';
const SITE_A = `http://${DOMAIN_A}.localhost:${PORT}/`;
const SITE_B = `http://${DOMAIN_B}.localhost:${PORT}/`;

// The waits of one load's pipeline, so a load ends within their sum.
const MARK_TIMEOUT = 90_000;
const FRAME_TIMEOUT = 30_000;
const IDLE_TIMEOUT = 5_000;
const LOAD_TIMEOUT = 2 * MARK_TIMEOUT + FRAME_TIMEOUT + IDLE_TIMEOUT;

const RUN_KINDS: RunKind[] = ['cold', 'warm', 'lukewarm'];

const TITLES: Record<RunKind, string> = {
  cold: 'COLD START',
  warm: 'WARM START',
  lukewarm: `LUKEWARM START (${DOMAIN_A} to ${DOMAIN_B})`,
};

/**
 * Stats over `rawValues` without those over twice the best, since an iteration with unreachable peers skews every
 * metric.
 */
function computeStats(rawValues: number[]): PhaseStats {
  const best = Math.min(...rawValues);
  const values = rawValues.filter(v => v <= best * 2);
  const discarded = rawValues.length - values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const m = ss.mean(values);
  const sd = ss.standardDeviation(values);
  return {
    p50: Math.round(ss.quantileSorted(sorted, 0.5)),
    p95: Math.round(ss.quantileSorted(sorted, 0.95)),
    p99: Math.round(ss.quantileSorted(sorted, 0.99)),
    mean: Math.round(m),
    stddev: Math.round(sd),
    cv: m > 0 ? Math.round((sd / m) * 100) / 100 : 0,
    min: ss.min(values),
    max: ss.max(values),
    values,
    discarded,
  };
}

/** The dotli marks of the document it runs in, with that document's time origin. Runs in the page. */
function readMarks(): { marks: PerfMark[]; timeOrigin: number } {
  return {
    marks: performance
      .getEntriesByType('mark')
      .filter(m => m.name.startsWith('dotli:'))
      .map(m => ({ name: m.name, startTime: m.startTime })),
    timeOrigin: performance.timeOrigin,
  };
}

/** The host's marks and the app frame's, on the host's timeline. */
async function collectMarks(page: Page, appFrame: Frame | null): Promise<PerfMark[]> {
  const hostData = await page.evaluate(readMarks);
  if (appFrame === null) {
    return hostData.marks;
  }

  const appData = await appFrame.evaluate(readMarks);
  const offset = appData.timeOrigin - hostData.timeOrigin;
  const normalizedAppMarks = appData.marks.map(m => ({
    name: m.name,
    startTime: m.startTime + offset,
  }));
  return [...hostData.marks, ...normalizedAppMarks];
}

/** Each phase's duration, for the phases whose start and end were both marked. */
function computePhases(marks: PerfMark[]): Map<string, number> {
  const byName = new Map(marks.map(m => [m.name, m.startTime]));
  const durations = new Map<string, number>();
  for (const { name, startMark, endMark } of PHASES) {
    const start = byName.get(startMark);
    const end = byName.get(endMark);
    if (start !== undefined && end !== undefined) {
      durations.set(name, Math.round(end - start));
    }
  }
  return durations;
}

/**
 * Waits for the host's end and the app frame's, and returns the app frame, or null when none appeared. Rejects with a
 * `TimeoutError` when the host never marks its end.
 */
async function waitForPipeline(page: Page): Promise<Frame | null> {
  await page.waitForFunction(() => performance.getEntriesByType('mark').some(m => m.name === 'dotli:main:end'), {
    timeout: MARK_TIMEOUT,
    polling: 500,
  });

  const appFrame = await findAppFrame(page, FRAME_TIMEOUT);
  if (appFrame === null) {
    console.log('  Warning: app iframe not found within timeout');
  } else {
    try {
      await appFrame.waitForFunction(() => performance.getEntriesByType('mark').some(m => m.name === 'dotli:app:end'), {
        timeout: MARK_TIMEOUT,
        polling: 500,
      });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }
      console.log('  Warning: app frame did not signal completion (dotli:app:end)');
    }
  }

  // Some phases emit marks after `dotli:app:end`.
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch((error: unknown) => {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
  });
  return appFrame;
}

async function getBrowserMetrics(page: Page): Promise<{ domContentLoaded: number; jsHeapUsed: number }> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const memory = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number };
      }
    ).memory;
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      jsHeapUsed: memory?.usedJSHeapSize ?? 0,
    };
  });
}

/**
 * Runs `load` on `page` and measures it once its pipeline ended, with every response it got. Rejects with a
 * `TimeoutError` when the host never marks its end.
 */
async function measureLoad(page: Page, load: () => Promise<unknown>): Promise<SingleRun> {
  const sizeReads: Promise<number>[] = [];
  page.on('response', recordSize);
  try {
    await load();
    const appFrame = await waitForPipeline(page);
    const phases = computePhases(await collectMarks(page, appFrame));
    const { domContentLoaded, jsHeapUsed } = await getBrowserMetrics(page);
    const responseSizes = await Promise.all(sizeReads);
    return {
      phases,
      domContentLoaded,
      jsHeapUsed,
      requestCount: responseSizes.length,
      totalBytes: responseSizes.reduce((sum, size) => sum + size, 0),
    };
  } finally {
    page.off('response', recordSize);
  }

  function recordSize(response: Response): void {
    // A response with no body, such as a redirect, rejects the read.
    sizeReads.push(
      response.body().then(
        body => body.length,
        () => 0,
      ),
    );
  }
}

/** The delta of `current` from `reference`, with whether it got faster. */
function fmtChange(current: number, reference: number): string {
  const direction = current < reference ? 'faster' : current > reference ? 'slower' : 'same';
  return `${fmtDelta(current, reference)} ${direction}`;
}

/** Runs `iterate` once per iteration and keeps the runs that finished. An iteration that timed out is skipped. */
async function runIterations(label: string, iterate: () => Promise<SingleRun>): Promise<SingleRun[]> {
  const runs: SingleRun[] = [];
  for (let i = 0; i < NUM_RUNS; i++) {
    const name = `${label} iteration ${String(i + 1)}/${String(NUM_RUNS)}`;
    console.log(`  ${name}...`);
    try {
      runs.push(await iterate());
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }
      console.log(`  ⏱ ${name} timed out, skipping`);
    }
  }
  return runs;
}

/** The stats of `runs`, or null when no iteration finished. */
function aggregateRuns(runs: SingleRun[]): RunStats | null {
  if (runs.length === 0) {
    return null;
  }

  const phaseStats: Record<string, PhaseStats> = {};
  for (const { name } of PHASES) {
    const values = runs.flatMap(run => run.phases.get(name) ?? []);
    if (values.length > 0) {
      phaseStats[name] = computeStats(values);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    iterations: runs.length,
    phases: phaseStats,
    browserMetrics: {
      domContentLoaded: computeStats(runs.map(r => r.domContentLoaded)),
      jsHeapUsed: computeStats(runs.map(r => r.jsHeapUsed)),
    },
    networkStats: {
      requestCount: computeStats(runs.map(r => r.requestCount)),
      totalBytes: computeStats(runs.map(r => r.totalBytes)),
    },
  };
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function cvFlag(cv: number): string {
  if (cv > VERY_NOISY_CV) {
    return `${RED}!!${RESET}`;
  }
  if (cv > NOISY_CV) {
    return `${YELLOW}!${RESET}`;
  }
  return '';
}

function printStatsTable(title: string, stats: RunStats, baseStats: RunStats | null, lastStats: RunStats | null): void {
  const div = '─'.repeat(100);
  const totalPhase = stats.phases[TOTAL_PHASE];

  console.log(`\n${div}`);
  console.log(`  ${title}  (${String(stats.iterations)} iterations)`);

  if (totalPhase !== undefined) {
    printSummary(totalPhase, baseStats, lastStats);
  }

  console.log(div);

  if (!PERF_VERBOSE) {
    console.log(`  ${DIM}Set PERF_VERBOSE=1 for detailed phase breakdown${RESET}\n`);
    return;
  }

  const dcl = stats.browserMetrics.domContentLoaded;
  const heap = stats.browserMetrics.jsHeapUsed;
  const reqs = stats.networkStats.requestCount;
  const bytes = stats.networkStats.totalBytes;
  console.log(
    `\n  DOMContentLoaded:  p50=${fmt(dcl.p50)}  p95=${fmt(dcl.p95)}  p99=${fmt(dcl.p99)}  cv=${dcl.cv.toFixed(2)}`,
  );
  console.log(
    `  JS Heap Used:      p50=${(heap.p50 / 1024 / 1024).toFixed(1)}MB  p95=${(heap.p95 / 1024 / 1024).toFixed(1)}MB`,
  );
  console.log(`  Network Requests:  p50=${String(reqs.p50)}  range=${String(reqs.min)}-${String(reqs.max)}`);
  console.log(`  Bytes Transferred: p50=${(bytes.p50 / 1024 / 1024).toFixed(2)}MB`);

  printPhaseTable(stats, baseStats, lastStats);

  if (totalPhase !== undefined) {
    console.log(`\n  ${DIM}Iterations: [${totalPhase.values.map(v => fmt(v)).join(', ')}]${RESET}`);
  }

  console.log(`\n${div}\n`);
}

/** Prints the end-to-end line, against the base and last runs that have one. */
function printSummary(totalPhase: PhaseStats, baseStats: RunStats | null, lastStats: RunStats | null): void {
  let summary = `  p50: ${fmt(totalPhase.p50)}  |  p95: ${fmt(totalPhase.p95)}  |  cv: ${totalPhase.cv.toFixed(2)}`;

  const bp = baseStats?.phases[TOTAL_PHASE];
  const lp = lastStats?.phases[TOTAL_PHASE];

  if (bp !== undefined) {
    summary += `  |  vs base p50: ${fmtChange(totalPhase.p50, bp.p50)}`;
  }
  if (lp !== undefined) {
    summary += `  |  vs last p50: ${fmtChange(totalPhase.p50, lp.p50)}`;
  }

  console.log(summary);

  if (totalPhase.cv > NOISY_CV) {
    console.log(
      `  ${YELLOW}Warning: CV=${totalPhase.cv.toFixed(2)}: high variance, results may not be reliable.${RESET}`,
    );
  }
}

/** Prints a row per phase, with a delta column for each of the base and last runs that has phases. */
function printPhaseTable(stats: RunStats, baseStats: RunStats | null, lastStats: RunStats | null): void {
  const columns = [
    { label: 'vs Base (p50)', reference: baseStats },
    { label: 'vs Last (p50)', reference: lastStats },
  ].flatMap(({ label, reference }) =>
    reference !== null && Object.keys(reference.phases).length > 0 ? [{ label, phases: reference.phases }] : [],
  );

  const header = `\n  ${'Phase'.padEnd(22)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'p99'.padStart(9)} ${'Mean'.padStart(9)} ${'StdDev'.padStart(9)} ${'CV'.padStart(6)}`;
  console.log(header + columns.map(({ label }) => `  ${label.padStart(26)}`).join(''));

  const line = `  ${'─'.repeat(22)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(6)}`;
  console.log(line + columns.map(() => `  ${'─'.repeat(26)}`).join(''));

  for (const { name } of PHASES) {
    const s = stats.phases[name];
    if (s === undefined) {
      continue;
    }
    const flag = cvFlag(s.cv);
    const dropped = s.discarded > 0 ? ` ${DIM}(-${String(s.discarded)})${RESET}` : '';
    const row = `  ${indentPhase(name).padEnd(22)} ${fmt(s.p50).padStart(9)} ${fmt(s.p95).padStart(9)} ${fmt(s.p99).padStart(9)} ${fmt(s.mean).padStart(9)} ${('±' + fmt(s.stddev)).padStart(9)} ${s.cv.toFixed(2).padStart(5)}${flag}${dropped}`;
    const deltas = columns.map(({ phases }) => {
      const reference = phases[name];
      return `  ${(reference === undefined ? '—' : fmtChange(s.p50, reference.p50)).padStart(26)}`;
    });

    console.log(row + deltas.join(''));
  }
}

/** A first visit in a fresh session. */
async function runColdIteration(browser: Browser): Promise<SingleRun> {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    return await measureLoad(page, () => page.goto(SITE_A, { waitUntil: 'commit' }));
  } finally {
    await context.close();
  }
}

/** Reloads of one site whose caches a first load populated. */
async function runWarmIterations(browser: Browser): Promise<SingleRun[]> {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    console.log(`  Warm: initial load (populating caches)...`);
    await page.goto(SITE_A, { waitUntil: 'commit' });
    await waitForPipeline(page);
    return await runIterations('Warm', () => measureLoad(page, () => page.reload({ waitUntil: 'commit' })));
  } finally {
    await context.close();
  }
}

/** A second site in a primed session: shared HTTP and wasm caches, but its own CID cache, SW and IndexedDB. */
async function runLukewarmIteration(browser: Browser): Promise<SingleRun> {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    console.log(`    Priming with ${DOMAIN_A}.dot...`);
    const primePage = await context.newPage();
    await primePage.goto(SITE_A, { waitUntil: 'commit' });
    await waitForPipeline(primePage);

    console.log(`    Loading ${DOMAIN_B}.dot (lukewarm)...`);
    const page = await context.newPage();
    return await measureLoad(page, () => page.goto(SITE_B, { waitUntil: 'commit' }));
  } finally {
    await context.close();
  }
}

// A cold iteration loads once, a lukewarm one twice, and the warm run once more to prime its caches. The extra half
// minute covers the navigations.
test.setTimeout((4 * NUM_RUNS + 1) * LOAD_TIMEOUT + 30_000);

// One test, so one worker measures every kind and its afterAll sees them all, even after a kind failed.
test.describe('Cold Start Performance', () => {
  const runs: Record<RunKind, SingleRun[]> = { cold: [], warm: [], lukewarm: [] };

  test(`As a dotli maintainer, I measure cold, warm and lukewarm starts over ${String(NUM_RUNS)} iterations and each records a run`, async ({
    browser,
  }) => {
    // When
    runs.cold = await test.step('cold start', () => runIterations('Cold', () => runColdIteration(browser)));
    runs.warm = await test.step('warm start', () => runWarmIterations(browser));
    runs.lukewarm = await test.step(`lukewarm start from ${DOMAIN_A} to ${DOMAIN_B}`, () =>
      runIterations('Lukewarm', () => runLukewarmIteration(browser)));

    // Then
    expect({ cold: runs.cold.length > 0, warm: runs.warm.length > 0, lukewarm: runs.lukewarm.length > 0 }).toEqual({
      cold: true,
      warm: true,
      lukewarm: true,
    });
  });

  // Prints each kind's stats against the saved runs, then saves these as the last runs. A kind with no finished
  // iteration is saved as missing, so no earlier run reads as this one.
  test.afterAll(() => {
    const base = loadResults(BASE_FILE);
    const last = loadResults(LAST_FILE);
    const results: SavedResults = { cold: null, warm: null, lukewarm: null };
    for (const kind of RUN_KINDS) {
      const run = aggregateRuns(runs[kind]);
      if (run !== null) {
        printStatsTable(TITLES[kind], run, base?.[kind] ?? null, last?.[kind] ?? null);
      }
      results[kind] = run;
    }

    saveResults(LAST_FILE, results);
    console.log(`  Results saved to ${LAST_FILE}`);

    if (SAVE_AS_BASE) {
      // A base with nothing in it would stand in for a real one until deleted.
      if (RUN_KINDS.every(kind => results[kind] === null)) {
        console.log(`  No iteration finished, so no base is saved.`);
      } else if (fs.existsSync(BASE_FILE)) {
        console.log(`  Base already exists, not overwritten.`);
        console.log(`  Delete ${BASE_FILE} manually to reset.`);
      } else {
        saveResults(BASE_FILE, results);
        console.log(`  Base results saved to ${BASE_FILE}`);
      }
    }
  });
});
