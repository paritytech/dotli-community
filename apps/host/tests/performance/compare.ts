// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Diffs `base.json` against `last.json` per phase. Trust a mean only when cv is low on both runs.
//
//   npm run test:perf:compare

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
  fmtPct,
  loadResults,
  type PhaseStats,
  type RunKind,
  type RunStats,
  type SavedResults,
} from './results.ts';

const R = '\x1b[0m';
const G = '\x1b[32m';
const RD = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const B = '\x1b[1m';

const ORDERED_PHASES = PHASES.map(({ name }) => name);

/** The normal approximation of the Mann-Whitney test is usual from this many samples a side. */
const MIN_SAMPLES = 8;

/** How each verdict shows on the console and in the report. */
const VERDICTS = {
  improved: { color: G, icon: '+', emoji: '🟢' },
  mixed: { color: Y, icon: '~', emoji: '🟡' },
  regressed: { color: RD, icon: '-', emoji: '🔴' },
  unchanged: { color: D, icon: '=', emoji: '⚪' },
  // A big delta without enough samples for significance.
  uncertain: { color: Y, icon: '?', emoji: '🟠' },
};

/** Each kind of run with its heading, in report order. The console titles it in capitals. */
const RUN_KINDS: { kind: RunKind; heading: string }[] = [
  { kind: 'cold', heading: 'Cold Start' },
  { kind: 'warm', heading: 'Warm Start' },
  { kind: 'lukewarm', heading: 'Lukewarm Start (different site, same session)' },
];

type Verdict = keyof typeof VERDICTS;

type MannWhitney = { z: number; significant: boolean };

/** One phase on both runs, judged. */
type Judged = { base: PhaseStats; last: PhaseStats; verdict: Verdict; test: MannWhitney };

type PhaseRow =
  | ({ phase: string; kind: 'compared' } & Judged)
  | { phase: string; kind: 'removed'; base: PhaseStats }
  | { phase: string; kind: 'new'; last: PhaseStats };

/** The last run against the base run, which the report and the console only format. */
type Comparison = {
  base: RunStats;
  last: RunStats;
  /** The total phase, null when either run lacks it. `noisy` when either run's cv is over the noise bound. */
  total: (Judged & { noisy: boolean }) | null;
  /** A row per phase either run has, in report order. */
  rows: PhaseRow[];
};

/** A run with no base to compare against, which the report and the console only format. */
type Standalone = {
  run: RunStats;
  total: PhaseStats | null;
  /** A row per phase the run has, in report order. */
  rows: { phase: string; stats: PhaseStats }[];
};

/** What the report says about one kind of run. */
type RunReport = { heading: string } & (
  { kind: 'missing' } | { kind: 'standalone'; standalone: Standalone } | { kind: 'compared'; comparison: Comparison }
);

/** A report per kind of run: missing when the last results lack it, compared when the base holds it too. */
function getRunReports(base: SavedResults, last: SavedResults): RunReport[] {
  return RUN_KINDS.map(({ kind, heading }): RunReport => {
    const baseRun = base[kind];
    const lastRun = last[kind];
    if (lastRun === null) {
      return { heading, kind: 'missing' };
    }
    return baseRun === null
      ? { heading, kind: 'standalone', standalone: describeRun(lastRun) }
      : { heading, kind: 'compared', comparison: compareRuns(baseRun, lastRun) };
  });
}

function formatReportMd(report: RunReport): string {
  switch (report.kind) {
    case 'missing':
      return `### ${report.heading}\n\nNo iteration finished.`;
    case 'standalone':
      return standaloneRunMd(report.heading, report.standalone);
    case 'compared':
      return compareRunsMd(report.heading, report.comparison);
  }
}

function printReport(report: RunReport, verbose: boolean): void {
  const title = report.heading.toUpperCase();
  switch (report.kind) {
    case 'missing':
      console.log(`  ${B}${title}${R}  ${D}(no iteration finished)${R}`);
      return;
    case 'standalone':
      printStandalone(title, report.standalone, verbose);
      return;
    case 'compared':
      printComparison(title, report.comparison, verbose);
      return;
  }
}

function describeRun(run: RunStats): Standalone {
  return {
    run,
    total: run.phases[TOTAL_PHASE] ?? null,
    rows: ORDERED_PHASES.flatMap(phase => {
      const stats = run.phases[phase];
      return stats === undefined ? [] : [{ phase, stats }];
    }),
  };
}

function compareRuns(base: RunStats, last: RunStats): Comparison {
  const bTotal = base.phases[TOTAL_PHASE];
  const lTotal = last.phases[TOTAL_PHASE];
  return {
    base,
    last,
    total:
      bTotal === undefined || lTotal === undefined
        ? null
        : { ...judge(bTotal, lTotal), noisy: bTotal.cv > NOISY_CV || lTotal.cv > NOISY_CV },
    rows: ORDERED_PHASES.flatMap(phase => comparePhase(phase, base.phases[phase], last.phases[phase])),
  };
}

function comparePhase(phase: string, base: PhaseStats | undefined, last: PhaseStats | undefined): PhaseRow[] {
  if (base === undefined) {
    return last === undefined ? [] : [{ phase, kind: 'new', last }];
  }
  if (last === undefined) {
    return [{ phase, kind: 'removed', base }];
  }
  return [{ phase, kind: 'compared', ...judge(base, last) }];
}

function judge(base: PhaseStats, last: PhaseStats): Judged {
  const test = mannWhitneyU(base.values, last.values);
  return { base, last, test, verdict: getVerdict(base, last, test.significant) };
}

function getVerdict(base: PhaseStats, last: PhaseStats, significant: boolean): Verdict {
  const p50Diff = last.p50 - base.p50;
  const p95Diff = last.p95 - base.p95;
  const p50Pct = base.p50 > 0 ? Math.abs(p50Diff / base.p50) : 0;

  if (significant) {
    if (p50Diff < 0) {
      return p95Diff <= 0 ? 'improved' : 'mixed';
    }
    if (p50Diff > 0) {
      return p95Diff >= 0 ? 'regressed' : 'mixed';
    }
  }

  return p50Pct < 0.05 ? 'unchanged' : 'uncertain';
}

/** The Mann-Whitney U test of `a` against `b`, significant at p < 0.05. Fewer samples than its bound are never. */
function mannWhitneyU(a: number[], b: number[]): MannWhitney {
  if (a.length < MIN_SAMPLES || b.length < MIN_SAMPLES) {
    return { z: 0, significant: false };
  }

  const combined = [...a.map(v => ({ v, group: 0 })), ...b.map(v => ({ v, group: 1 }))].sort((x, y) => x.v - y.v);
  const tieRuns = findTieRuns(combined.map(({ v }) => v));

  let rankSumA = 0;
  for (const [start, end] of tieRuns) {
    const avgRank = (start + 1 + end) / 2; // average rank for ties
    rankSumA += avgRank * combined.slice(start, end).filter(({ group }) => group === 0).length;
  }

  const n1 = a.length;
  const n2 = b.length;
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  const mu = (n1 * n2) / 2;
  const n = n1 + n2;

  const tieGroups = tieRuns.map(([start, end]) => end - start).filter(size => size > 1);
  const tieCorrection = tieGroups.reduce((s, t) => s + (t * t * t - t) / (n * (n - 1)), 0);

  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieCorrection));
  const z = Math.abs(sigma > 0 ? (u - mu) / sigma : 0);

  return { z, significant: z > 1.96 };
}

/** The runs of equal values in `sorted`, each as its start index and its end index past the run. */
function findTieRuns(sorted: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end < sorted.length && sorted[end] === sorted[start]) {
      end++;
    }
    runs.push([start, end]);
    start = end;
  }
  return runs;
}

/** Green for faster, red for slower. */
function deltaColor(current: number, reference: number): string {
  if (current < reference) {
    return G;
  }
  return current > reference ? RD : '';
}

function cvColor(cv: number): string {
  if (cv > VERY_NOISY_CV) {
    return RD;
  }
  if (cv > NOISY_CV) {
    return Y;
  }
  return '';
}

function standaloneRunMd(label: string, { total, rows }: Standalone): string {
  const lines: string[] = [];

  lines.push(`### ${label}`);
  lines.push('');

  if (total !== null) {
    lines.push(
      `**Overall:** p50: ${fmt(total.p50)} &nbsp;|&nbsp; p95: ${fmt(total.p95)} &nbsp;|&nbsp; cv: ${total.cv.toFixed(2)}`,
    );
    lines.push('');
  }

  lines.push('<details>');
  lines.push(`<summary>Phase breakdown</summary>`);
  lines.push('');
  lines.push('| Phase | p50 | p95 | p99 | cv |');
  lines.push('|-------|-----|-----|-----|----|');

  for (const { phase, stats: s } of rows) {
    lines.push(`| ${phase} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${s.cv.toFixed(2)} |`);
  }

  lines.push('');
  lines.push('</details>');

  return lines.join('\n');
}

function compareRunsMd(label: string, { total, rows }: Comparison): string {
  const lines: string[] = [];

  lines.push(`### ${label}`);
  lines.push('');

  if (total !== null) {
    const { base, last, verdict, test } = total;
    lines.push(
      `**Overall:** ${VERDICTS[verdict].emoji} **${verdict}** &nbsp;|&nbsp; ` +
        `p50: ${fmt(base.p50)} to ${fmt(last.p50)} (${fmtPct(last.p50, base.p50)}) &nbsp;|&nbsp; ` +
        `p95: ${fmt(base.p95)} to ${fmt(last.p95)} (${fmtPct(last.p95, base.p95)}) &nbsp;|&nbsp; ` +
        `Mann-Whitney: z=${test.z.toFixed(2)} ${test.significant ? '✅ significant' : 'not significant'}`,
    );

    if (total.noisy) {
      lines.push('');
      lines.push(`> ⚠️ High variance (CV > ${String(NOISY_CV)}). Results may not be reliable.`);
    }
    lines.push('');
  }

  lines.push('<details>');
  lines.push(`<summary>Phase breakdown</summary>`);
  lines.push('');
  lines.push('| Phase | Base p50 | PR p50 | p50 Δ | Base p95 | PR p95 | p95 Δ | Verdict |');
  lines.push('|-------|----------|--------|-------|----------|--------|-------|---------|');

  for (const row of rows) {
    const name = row.phase;
    switch (row.kind) {
      case 'removed':
        lines.push(`| ${name} | ${fmt(row.base.p50)} | — | removed | — | — | — | — |`);
        break;
      case 'new':
        lines.push(`| ${name} | — | ${fmt(row.last.p50)} | new | — | — | — | — |`);
        break;
      case 'compared': {
        const { base, last, verdict } = row;
        lines.push(
          `| ${name} | ${fmt(base.p50)} | ${fmt(last.p50)} | ${fmtDelta(last.p50, base.p50)} | ${fmt(base.p95)} | ${fmt(last.p95)} | ${fmtDelta(last.p95, base.p95)} | ${VERDICTS[verdict].emoji} ${verdict} |`,
        );
        break;
      }
    }
  }

  lines.push('');
  lines.push('</details>');

  return lines.join('\n');
}

function printStandalone(label: string, { run, total, rows }: Standalone, verbose: boolean): void {
  const thin = '─'.repeat(100);

  if (total !== null) {
    console.log(
      `  ${B}${label}${R}  ${D}(no baseline)${R}  |  p50: ${fmt(total.p50)}  |  p95: ${fmt(total.p95)}  |  cv: ${total.cv.toFixed(2)}`,
    );
  } else {
    console.log(`  ${B}${label}${R}  ${D}(no baseline, no end-to-end data)${R}`);
  }

  if (!verbose) {
    return;
  }

  console.log(thin);
  console.log(`  ${run.timestamp} (${String(run.iterations)} runs)`);
  console.log(
    `\n  ${'Phase'.padEnd(22)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'p99'.padStart(9)}  ${'cv'.padStart(5)}`,
  );
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)}  ${'─'.repeat(5)}`);

  for (const { phase, stats: s } of rows) {
    const cv = `${cvColor(s.cv)}${s.cv.toFixed(2)}${R}`;
    console.log(
      `  ${indentPhase(phase).padEnd(22)} ${fmt(s.p50).padStart(9)} ${fmt(s.p95).padStart(9)} ${fmt(s.p99).padStart(9)}  ${cv}`,
    );
  }

  console.log(`\n${thin}`);
}

function printComparison(label: string, comparison: Comparison, verbose: boolean): void {
  const { base, last, total, rows } = comparison;
  const thin = '─'.repeat(140);

  printComparisonSummary(label, total);

  if (!verbose) {
    return;
  }

  console.log(thin);
  console.log(
    `  Base: ${base.timestamp} (${String(base.iterations)} runs)    Last: ${last.timestamp} (${String(last.iterations)} runs)`,
  );

  console.log(
    `\n  ${'Phase'.padEnd(22)} ${'Base p50'.padStart(9)} ${'Last p50'.padStart(9)} ${'p50 Δ'.padStart(24)}  ${'Base p95'.padStart(9)} ${'Last p95'.padStart(9)} ${'p95 Δ'.padStart(24)}  ${'B cv'.padStart(5)} ${'L cv'.padStart(5)}  ${'Verdict'.padStart(12)}`,
  );
  console.log(
    `  ${'─'.repeat(22)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(24)}  ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(24)}  ${'─'.repeat(5)} ${'─'.repeat(5)}  ${'─'.repeat(12)}`,
  );

  for (const row of rows) {
    const name = indentPhase(row.phase).padEnd(22);
    switch (row.kind) {
      case 'removed':
        console.log(`  ${name} ${fmt(row.base.p50).padStart(9)} ${'—'.padStart(9)} ${D}${'removed'.padStart(24)}${R}`);
        break;
      case 'new':
        console.log(`  ${name} ${'—'.padStart(9)} ${fmt(row.last.p50).padStart(9)} ${D}${'new'.padStart(24)}${R}`);
        break;
      case 'compared': {
        const { base: b, last: l, verdict } = row;
        const { color, icon } = VERDICTS[verdict];
        const p50Delta = `${deltaColor(l.p50, b.p50)}${fmtDelta(l.p50, b.p50).padStart(24)}${R}`;
        const p95Delta = `${deltaColor(l.p95, b.p95)}${fmtDelta(l.p95, b.p95).padStart(24)}${R}`;
        const bCv = `${cvColor(b.cv)}${b.cv.toFixed(2)}${R}`;
        const lCv = `${cvColor(l.cv)}${l.cv.toFixed(2)}${R}`;
        console.log(
          `  ${name} ${fmt(b.p50).padStart(9)} ${fmt(l.p50).padStart(9)} ${p50Delta}  ${fmt(b.p95).padStart(9)} ${fmt(l.p95).padStart(9)} ${p95Delta}  ${bCv} ${lCv}  ${color}${`${icon} ${verdict}`.padStart(12)}${R}`,
        );
        break;
      }
    }
  }

  if (total !== null) {
    console.log(`\n  ${D}Base runs:  [${total.base.values.map(v => fmt(v)).join(', ')}]${R}`);
    console.log(`  ${D}Last runs:  [${total.last.values.map(v => fmt(v)).join(', ')}]${R}`);
  }

  console.log(`\n${thin}`);
}

/** Prints the total phase's line of `label`. */
function printComparisonSummary(label: string, total: Comparison['total']): void {
  if (total === null) {
    console.log(`  ${B}${label}${R}  ${D}(no end-to-end data to compare)${R}`);
    return;
  }

  const { base, last, verdict, test } = total;
  const { color, icon } = VERDICTS[verdict];
  const p50Color = deltaColor(last.p50, base.p50);
  const p95Color = deltaColor(last.p95, base.p95);

  console.log(
    `  ${B}${label}${R}  ${color}${icon} ${verdict}${R}  |  ` +
      `p50: ${fmt(base.p50)} to ${p50Color}${fmt(last.p50)}${R} (${p50Color}${fmtPct(last.p50, base.p50)}${R})  |  ` +
      `p95: ${fmt(base.p95)} to ${p95Color}${fmt(last.p95)}${R} (${p95Color}${fmtPct(last.p95, base.p95)}${R})  |  ` +
      `Mann-Whitney: z=${test.z.toFixed(2)} ${test.significant ? `${G}significant${R}` : `${D}not significant${R}`}`,
  );

  if (total.noisy) {
    console.log(`  ${Y}Warning: CV > ${String(NOISY_CV)}. Results may not be reliable.${R}`);
  }
}

function getCommitRef(): string {
  const sha = process.env['GITHUB_SHA'];
  const server = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const repo = process.env['GITHUB_REPOSITORY'] ?? '';
  return sha !== undefined && sha !== '' && repo !== ''
    ? `[${sha.slice(0, 7)}](${server}/${repo}/commit/${sha})`
    : 'local';
}

const markdown = process.argv.includes('--markdown');
const verbose = process.argv.includes('--verbose');

const base = loadResults(BASE_FILE);
const last = loadResults(LAST_FILE);

if (!base) {
  console.error('No base results found. Run: npm run test:perf:base');
  process.exit(1);
}

if (!last) {
  console.error('No last results found. Run: npm run test:perf');
  process.exit(1);
}

const reports = getRunReports(base, last);

if (markdown) {
  const sections = ['## ⚡ Performance Report'];
  for (const report of reports) {
    sections.push('', formatReportMd(report));
  }
  sections.push('', `<sub>Commit: ${getCommitRef()} &nbsp;|&nbsp; Outliers (>2x best) discarded before stats</sub>`);
  console.log(sections.join('\n'));
} else {
  console.log(`\n  ${B}dot.li Performance Comparison: Base vs Last${R}`);
  if (!verbose) {
    console.log(`  ${D}Use --verbose for detailed phase breakdown${R}`);
  }
  console.log('');

  for (const report of reports) {
    printReport(report, verbose);
  }
}
