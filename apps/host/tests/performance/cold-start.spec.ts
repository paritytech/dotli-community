// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Usage:
//   npm run test:perf               run N iterations, save to last.json
//   npm run test:perf:base          save as base.json
//   npm run test:perf:compare       diff base against last
//   PERF_RUNS=5 npm run test:perf   override the iteration count

import { test, expect, type Page, type Browser } from '@playwright/test';
import * as ss from 'simple-statistics';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findAppFrame } from '../product-frame.js';

interface PerfMark {
  name: string;
  startTime: number;
}

interface PhaseResult {
  phase: string;
  start: number;
  end: number;
  duration: number;
}

export interface PhaseStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  cv: number; // coefficient of variation (stddev/mean), >0.3 = noisy
  min: number;
  max: number;
  values: number[];
  discarded: number; // iterations removed as outliers (> 2x best time)
}

export interface RunStats {
  timestamp: string;
  type: 'cold' | 'warm' | 'lukewarm';
  iterations: number;
  phases: Record<string, PhaseStats>;
  browserMetrics: {
    domContentLoaded: PhaseStats;
    jsHeapUsed: PhaseStats;
  };
  networkStats: {
    requestCount: PhaseStats;
    totalBytes: PhaseStats;
  };
}

export interface SavedResults {
  cold: RunStats;
  warm: RunStats | null;
  lukewarm: RunStats | null;
}

const RESULTS_DIR = path.join(import.meta.dirname, 'results');
const BASE_FILE = path.join(RESULTS_DIR, 'base.json');
const LAST_FILE = path.join(RESULTS_DIR, 'last.json');
const SAVE_AS_BASE = process.env['PERF_SAVE_BASE'] === '1';
const NUM_RUNS = parseInt(process.env['PERF_RUNS'] ?? '10', 10);
const DOMAIN_A = process.env['PERF_DOMAIN_A'] ?? 'browse';
const DOMAIN_B = process.env['PERF_DOMAIN_B'] ?? 'host-playground';
const PORT = process.env['PERF_PORT'] ?? '5173';
const PERF_VERBOSE = process.env['PERF_VERBOSE'] === '1';
const ITERATION_TIMEOUT = 3 * 60_000;

const PHASE_PAIRS: [string, string, string][] = [
  ['End-to-end', 'dotli:main:start', 'dotli:app:end'],
  ['Host total', 'dotli:main:start', 'dotli:main:end'],
  ['SW registration', 'dotli:sw:start', 'dotli:sw:end'],
  ['Name resolution', 'dotli:resolve:start', 'dotli:resolve:end'],
  ['  Smoldot init', 'dotli:smoldot:init:start', 'dotli:smoldot:init:end'],
  ['    Relay chain', 'dotli:smoldot:relay:start', 'dotli:smoldot:relay:end'],
  ['    Parachain', 'dotli:smoldot:parachain:start', 'dotli:smoldot:parachain:end'],
  ['    Chain sync', 'dotli:smoldot:sync:start', 'dotli:smoldot:sync:end'],
  ['  SW smoldot', 'dotli:smoldot:sw:start', 'dotli:smoldot:sw:end'],
  ['App total', 'dotli:app:start', 'dotli:app:end'],
  ['  P2P attempt', 'dotli:fetch:p2p:start', 'dotli:fetch:p2p:end'],
  ['  Gateway fetch', 'dotli:fetch:gateway:start', 'dotli:fetch:gateway:end'],
  ['  Archive parse', 'dotli:fetch:parse:start', 'dotli:fetch:parse:end'],
];

/** Drops values over twice the best, since an iteration with unreachable peers skews every metric. */
function filterOutliers(values: number[]): {
  filtered: number[];
  discarded: number;
} {
  if (values.length < 2) {
    return { filtered: values, discarded: 0 };
  }
  const best = Math.min(...values);
  const threshold = best * 2;
  const filtered = values.filter(v => v <= threshold);
  if (filtered.length < 2) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      filtered: sorted.slice(0, 2),
      discarded: values.length - 2,
    };
  }
  return { filtered, discarded: values.length - filtered.length };
}

function computeStats(rawValues: number[]): PhaseStats {
  const { filtered: values, discarded } = filterOutliers(rawValues);
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

async function collectMarks(page: Page): Promise<PerfMark[]> {
  const hostData = await page.evaluate(() => ({
    marks: performance
      .getEntriesByType('mark')
      .filter(m => m.name.startsWith('dotli:'))
      .map(m => ({ name: m.name, startTime: m.startTime })),
    timeOrigin: performance.timeOrigin,
  }));

  const appFrame = page.frames().find(f => f.url().includes('.app.localhost'));
  if (!appFrame) {
    return hostData.marks;
  }

  try {
    const appData = await appFrame.evaluate(() => ({
      marks: performance
        .getEntriesByType('mark')
        .filter(m => m.name.startsWith('dotli:'))
        .map(m => ({ name: m.name, startTime: m.startTime })),
      timeOrigin: performance.timeOrigin,
    }));

    // Onto the host's timeline.
    const offset = appData.timeOrigin - hostData.timeOrigin;
    const normalizedAppMarks = appData.marks.map(m => ({
      name: m.name,
      startTime: m.startTime + offset,
    }));

    return [...hostData.marks, ...normalizedAppMarks];
  } catch {
    // The app frame may be inaccessible once document.write() replaces it.
    return hostData.marks;
  }
}

function computePhases(marks: PerfMark[]): PhaseResult[] {
  const byName = new Map<string, number>();
  for (const m of marks) {
    byName.set(m.name, m.startTime);
  }
  const phases: PhaseResult[] = [];
  for (const [label, startMark, endMark] of PHASE_PAIRS) {
    const start = byName.get(startMark);
    const end = byName.get(endMark);
    if (start !== undefined && end !== undefined) {
      phases.push({
        phase: label,
        start: Math.round(start),
        end: Math.round(end),
        duration: Math.round(end - start),
      });
    }
  }
  return phases;
}

async function waitForPipeline(page: Page): Promise<void> {
  await page.waitForFunction(() => performance.getEntriesByType('mark').some(m => m.name === 'dotli:main:end'), {
    timeout: 90_000,
    polling: 500,
  });

  const appFrame = await findAppFrame(page, 30_000);
  if (appFrame !== null) {
    try {
      await appFrame.waitForFunction(() => performance.getEntriesByType('mark').some(m => m.name === 'dotli:app:end'), {
        timeout: 90_000,
        polling: 500,
      });
    } catch {
      console.log('  Warning: app frame did not signal completion (dotli:app:end)');
    }
  } else {
    console.log('  Warning: app iframe not found within timeout');
  }

  // Some phases emit marks after `dotli:app:end`.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
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

function fmt(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDelta(current: number, reference: number): string {
  const diff = current - reference;
  const pct = reference > 0 ? ((diff / reference) * 100).toFixed(1) : 'N/A';
  const sign = diff > 0 ? '+' : '';
  const arrow = diff < 0 ? 'faster' : diff > 0 ? 'slower' : 'same';
  return `${sign}${fmt(diff)} (${sign}${pct}%) ${arrow}`;
}

function loadJson(filepath: string): SavedResults | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8')) as SavedResults;
  } catch {
    return null;
  }
}

function saveJson(filepath: string, data: SavedResults): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        console.log(`  ⏱ ${label} timed out after ${String(ms / 1000)}s — skipping`);
        resolve(null);
      }, ms);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface SingleRun {
  phases: PhaseResult[];
  domContentLoaded: number;
  jsHeapUsed: number;
  requestCount: number;
  totalBytes: number;
}

function aggregateRuns(type: RunStats['type'], runs: SingleRun[]): RunStats {
  const phaseNames = new Set<string>();
  for (const run of runs) {
    for (const p of run.phases) {
      phaseNames.add(p.phase);
    }
  }

  const phaseStats: Record<string, PhaseStats> = {};
  for (const name of phaseNames) {
    const values = runs
      .map(r => r.phases.find(p => p.phase === name)?.duration)
      .filter((v): v is number => v !== undefined);
    if (values.length > 0) {
      phaseStats[name] = computeStats(values);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    type,
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
  if (cv > 0.5) {
    return `${RED}!!${RESET}`;
  }
  if (cv > 0.3) {
    return `${YELLOW}!${RESET}`;
  }
  return '';
}

function printStatsTable(
  title: string,
  stats: RunStats,
  baseStats?: RunStats | null,
  lastStats?: RunStats | null,
): void {
  const div = '─'.repeat(100);
  const totalPhase = 'End-to-end' in stats.phases ? stats.phases['End-to-end'] : null;

  console.log(`\n${div}`);
  console.log(`  ${title}  (${String(stats.iterations)} iterations)`);

  if (totalPhase !== null) {
    let summary = `  p50: ${fmt(totalPhase.p50)}  |  p95: ${fmt(totalPhase.p95)}  |  cv: ${totalPhase.cv.toFixed(2)}`;

    const bp = baseStats?.phases['End-to-end'];
    const lp = lastStats?.phases['End-to-end'];

    if (bp !== undefined) {
      summary += `  |  vs base p50: ${fmtDelta(totalPhase.p50, bp.p50)}`;
    }
    if (lp !== undefined) {
      summary += `  |  vs last p50: ${fmtDelta(totalPhase.p50, lp.p50)}`;
    }

    console.log(summary);

    if (totalPhase.cv > 0.3) {
      console.log(
        `  ${YELLOW}Warning: CV=${totalPhase.cv.toFixed(2)} — high variance, results may not be reliable.${RESET}`,
      );
    }
  }

  console.log(div);

  if (!PERF_VERBOSE) {
    console.log(`  ${DIM}Set PERF_VERBOSE=1 for detailed phase breakdown${RESET}\n`);
    return;
  }

  const hasBase = baseStats !== undefined && baseStats !== null && Object.keys(baseStats.phases).length > 0;
  const hasLast = lastStats !== undefined && lastStats !== null && Object.keys(lastStats.phases).length > 0;

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

  let header = `\n  ${'Phase'.padEnd(22)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'p99'.padStart(9)} ${'Mean'.padStart(9)} ${'StdDev'.padStart(9)} ${'CV'.padStart(6)}`;
  if (hasBase) {
    header += `  ${'vs Base (p50)'.padStart(26)}`;
  }
  if (hasLast) {
    header += `  ${'vs Last (p50)'.padStart(26)}`;
  }
  console.log(header);

  let line = `  ${'─'.repeat(22)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(6)}`;
  if (hasBase) {
    line += `  ${'─'.repeat(26)}`;
  }
  if (hasLast) {
    line += `  ${'─'.repeat(26)}`;
  }
  console.log(line);

  for (const [name] of PHASE_PAIRS) {
    const s = stats.phases[name];
    if (s === undefined) {
      continue;
    }
    const flag = cvFlag(s.cv);
    const dropped = s.discarded > 0 ? ` ${DIM}(-${String(s.discarded)})${RESET}` : '';
    let row = `  ${name.padEnd(22)} ${fmt(s.p50).padStart(9)} ${fmt(s.p95).padStart(9)} ${fmt(s.p99).padStart(9)} ${fmt(s.mean).padStart(9)} ${('±' + fmt(s.stddev)).padStart(9)} ${s.cv.toFixed(2).padStart(5)}${flag}${dropped}`;

    if (hasBase) {
      const base = baseStats.phases[name];
      if (base !== undefined) {
        row += `  ${fmtDelta(s.p50, base.p50).padStart(26)}`;
      } else {
        row += `  ${'—'.padStart(26)}`;
      }
    }

    if (hasLast) {
      const last = lastStats.phases[name];
      if (last !== undefined) {
        row += `  ${fmtDelta(s.p50, last.p50).padStart(26)}`;
      } else {
        row += `  ${'—'.padStart(26)}`;
      }
    }

    console.log(row);
  }

  if (totalPhase !== null) {
    console.log(`\n  ${DIM}Iterations: [${totalPhase.values.map(v => fmt(v)).join(', ')}]${RESET}`);
  }

  console.log(`\n${div}\n`);
}

async function runColdIteration(browser: Browser, index: number, total: number): Promise<SingleRun> {
  console.log(`  Cold iteration ${String(index + 1)}/${String(total)}...`);

  const context = await browser.newContext({
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();

  const requests: { size: number }[] = [];
  page.on('response', async response => {
    try {
      const body = await response.body().catch(() => null);
      requests.push({ size: body?.length ?? 0 });
    } catch {
      requests.push({ size: 0 });
    }
  });

  await page.goto(`http://${DOMAIN_A}.localhost:${PORT}/`, {
    waitUntil: 'commit',
  });
  await waitForPipeline(page);

  const marks = await collectMarks(page);
  const phases = computePhases(marks);
  const bm = await getBrowserMetrics(page);

  await context.close();

  return {
    phases,
    domContentLoaded: bm.domContentLoaded,
    jsHeapUsed: bm.jsHeapUsed,
    requestCount: requests.length,
    totalBytes: requests.reduce((s, r) => s + r.size, 0),
  };
}

async function runWarmIterations(browser: Browser, total: number): Promise<SingleRun[]> {
  const context = await browser.newContext({
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();

  console.log(`  Warm: initial load (populating caches)...`);
  await page.goto(`http://${DOMAIN_A}.localhost:${PORT}/`, {
    waitUntil: 'commit',
  });
  await waitForPipeline(page);

  const runs: SingleRun[] = [];

  for (let i = 0; i < total; i++) {
    console.log(`  Warm iteration ${String(i + 1)}/${String(total)}...`);

    const iterationWork = async (): Promise<SingleRun> => {
      await page.evaluate(() => {
        performance.clearMarks();
      });
      await page.reload({ waitUntil: 'commit' });
      await waitForPipeline(page);

      const marks = await collectMarks(page);
      const phases = computePhases(marks);
      const bm = await getBrowserMetrics(page);

      return {
        phases,
        domContentLoaded: bm.domContentLoaded,
        jsHeapUsed: bm.jsHeapUsed,
        requestCount: 0,
        totalBytes: 0,
      };
    };

    const result = await withTimeout(
      iterationWork(),
      ITERATION_TIMEOUT,
      `Warm iteration ${String(i + 1)}/${String(total)}`,
    );
    if (result !== null) {
      runs.push(result);
    }
  }

  await context.close();
  return runs;
}

/** A second site in a primed session: shared HTTP and wasm caches, but its own CID cache, SW and IndexedDB. */
async function runLukewarmIterations(browser: Browser, total: number): Promise<SingleRun[]> {
  const runs: SingleRun[] = [];

  for (let i = 0; i < total; i++) {
    console.log(`  Lukewarm iteration ${String(i + 1)}/${String(total)}...`);

    const iterationWork = async (): Promise<SingleRun> => {
      const context = await browser.newContext({
        serviceWorkers: 'allow',
      });

      console.log(`    Priming with ${DOMAIN_A}.dot...`);
      const primePage = await context.newPage();
      await primePage.goto(`http://${DOMAIN_A}.localhost:${PORT}/`, {
        waitUntil: 'commit',
      });
      await waitForPipeline(primePage);

      console.log(`    Loading ${DOMAIN_B}.dot (lukewarm)...`);
      const page = await context.newPage();

      const requests: { size: number }[] = [];
      page.on('response', async response => {
        try {
          const body = await response.body().catch(() => null);
          requests.push({ size: body?.length ?? 0 });
        } catch {
          requests.push({ size: 0 });
        }
      });

      await page.goto(`http://${DOMAIN_B}.localhost:${PORT}/`, {
        waitUntil: 'commit',
      });
      await waitForPipeline(page);

      const marks = await collectMarks(page);
      const phases = computePhases(marks);
      const bm = await getBrowserMetrics(page);

      await context.close();

      return {
        phases,
        domContentLoaded: bm.domContentLoaded,
        jsHeapUsed: bm.jsHeapUsed,
        requestCount: requests.length,
        totalBytes: requests.reduce((s, r) => s + r.size, 0),
      };
    };

    const result = await withTimeout(
      iterationWork(),
      ITERATION_TIMEOUT,
      `Lukewarm iteration ${String(i + 1)}/${String(total)}`,
    );
    if (result !== null) {
      runs.push(result);
    }
  }

  return runs;
}

test.setTimeout(NUM_RUNS * 300_000 + 30_000);

test.describe('Cold Start Performance', () => {
  let coldStats: RunStats | null = null;
  let warmStats: RunStats | null = null;
  let lukewarmStats: RunStats | null = null;

  test(`measure cold start (${String(NUM_RUNS)} iterations)`, async ({ browser }) => {
    const runs: SingleRun[] = [];
    for (let i = 0; i < NUM_RUNS; i++) {
      const result = await withTimeout(
        runColdIteration(browser, i, NUM_RUNS),
        ITERATION_TIMEOUT,
        `Cold iteration ${String(i + 1)}/${String(NUM_RUNS)}`,
      );
      if (result !== null) {
        runs.push(result);
      }
    }

    coldStats = aggregateRuns('cold', runs);

    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);
    printStatsTable('COLD START', coldStats, base?.cold, last?.cold);

    expect(runs.length).toBeGreaterThan(0);
  });

  test(`measure warm start (${String(NUM_RUNS)} iterations)`, async ({ browser }) => {
    const runs = await runWarmIterations(browser, NUM_RUNS);

    warmStats = aggregateRuns('warm', runs);

    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);
    printStatsTable('WARM START', warmStats, base?.warm, last?.warm);

    expect(runs.length).toBeGreaterThan(0);
  });

  test(`measure lukewarm start (${String(NUM_RUNS)} iterations, ${DOMAIN_A}→${DOMAIN_B})`, async ({ browser }) => {
    const runs = await runLukewarmIterations(browser, NUM_RUNS);

    lukewarmStats = aggregateRuns('lukewarm', runs);

    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);
    printStatsTable(`LUKEWARM START (${DOMAIN_A}→${DOMAIN_B})`, lukewarmStats, base?.lukewarm, last?.lukewarm);

    expect(runs.length).toBeGreaterThan(0);
  });

  test.afterAll(() => {
    if (!coldStats) {
      return;
    }

    const results: SavedResults = {
      cold: coldStats,
      warm: warmStats,
      lukewarm: lukewarmStats,
    };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    saveJson(LAST_FILE, results);
    console.log(`  Results saved to ${LAST_FILE}`);

    if (SAVE_AS_BASE) {
      if (fs.existsSync(BASE_FILE)) {
        console.log(`  Base already exists — not overwritten.`);
        console.log(`  Delete ${BASE_FILE} manually to reset.`);
      } else {
        saveJson(BASE_FILE, results);
        console.log(`  Base results saved to ${BASE_FILE}`);
      }
    }
  });
});
