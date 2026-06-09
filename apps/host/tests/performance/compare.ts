#!/usr/bin/env bun
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Diffs perf runs and ranks deltas with statistical significance.
 *
 * Compares `base.json` vs `last.json` along p50 (primary), p95 (tail),
 * p99 (worst case), stddev, cv (stability), and runs a Mann-Whitney U
 * test for significance.
 *
 * Reading order:
 *   1. p50 first. Did the typical experience improve?
 *   2. p95 next. Did tail latency improve?
 *   3. cv. Did stability change?
 *   4. Only trust mean if cv is low on BOTH runs.
 *   5. Delta < 5% with < 30 samples is likely noise unless Mann-Whitney confirms.
 *
 * Run: bun run test:perf:compare
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface PhaseStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  cv: number;
  min: number;
  max: number;
  values: number[];
  discarded?: number;
}

interface RunStats {
  timestamp: string;
  type: "cold" | "warm" | "lukewarm";
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

interface SavedResults {
  cold: RunStats;
  warm?: RunStats | null;
  lukewarm?: RunStats | null;
}

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const BASE_FILE = path.join(RESULTS_DIR, "base.json");
const LAST_FILE = path.join(RESULTS_DIR, "last.json");

const R = "\x1b[0m";
const G = "\x1b[32m";
const RD = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const B = "\x1b[1m";

// Non-parametric test for comparing two independent samples.
// Returns z-score and whether the difference is significant
// at the 0.05 level (|z| > 1.96).

function mannWhitneyU(
  a: number[],
  b: number[],
): { u: number; z: number; significant: boolean } {
  // Need at least 2 values per sample for any meaningful test
  if (a.length < 2 || b.length < 2) {
    return { u: 0, z: 0, significant: false };
  }

  // Combine and rank
  const combined = [
    ...a.map((v) => ({ v, group: 0 })),
    ...b.map((v) => ({ v, group: 1 })),
  ].sort((x, y) => x.v - y.v);

  // Assign ranks with tie correction
  const ranks = new Array<number>(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length && combined[j].v === combined[i].v) {
      j++;
    }
    const avgRank = (i + 1 + j) / 2; // average rank for ties
    for (let k = i; k < j; k++) {
      ranks[k] = avgRank;
    }
    i = j;
  }

  // Sum ranks for group a
  let rankSumA = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 0) {
      rankSumA += ranks[k] ?? 0;
    }
  }

  const n1 = a.length;
  const n2 = b.length;
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  // Normal approximation (valid for n >= 3)
  const mu = (n1 * n2) / 2;
  const n = n1 + n2;

  // Tie correction
  const tieGroups: number[] = [];
  let ti = 0;
  while (ti < combined.length) {
    let tj = ti;
    while (tj < combined.length && combined[tj].v === combined[ti].v) {
      tj++;
    }
    if (tj - ti > 1) {
      tieGroups.push(tj - ti);
    }
    ti = tj;
  }
  const tieCorrection = tieGroups.reduce(
    (s, t) => s + (t * t * t - t) / (n * (n - 1)),
    0,
  );

  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieCorrection));
  const z = sigma > 0 ? (u - mu) / sigma : 0;

  return {
    u,
    z: Math.abs(z),
    significant: Math.abs(z) > 1.96, // p < 0.05
  };
}

function fmt(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtPct(current: number, reference: number): string {
  if (reference === 0) {
    return "N/A";
  }
  const pct = ((current - reference) / reference) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtDelta(current: number, reference: number): string {
  const diff = current - reference;
  const sign = diff > 0 ? "+" : "";
  const color = diff < 0 ? G : diff > 0 ? RD : "";
  return `${color}${sign}${fmt(diff)} (${fmtPct(current, reference)})${R}`;
}

function cvColor(cv: number): string {
  if (cv > 0.5) {
    return RD;
  }
  if (cv > 0.3) {
    return Y;
  }
  return "";
}

function loadJson(filepath: string): SavedResults | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as SavedResults;
  } catch {
    return null;
  }
}

const ORDERED_PHASES = [
  "End-to-end",
  "Host total",
  "SW registration",
  "Name resolution",
  "  Smoldot init",
  "    Relay chain",
  "    Parachain",
  "    Chain sync",
  "  SW smoldot",
  "App total",
  "  P2P attempt",
  "  Gateway fetch",
  "  Archive parse",
];

interface Verdict {
  label: string;
  color: string;
  icon: string;
}

function getVerdict(bStat: PhaseStats, lStat: PhaseStats): Verdict {
  const mw = mannWhitneyU(bStat.values, lStat.values);
  const p50Diff = lStat.p50 - bStat.p50;
  const p95Diff = lStat.p95 - bStat.p95;
  const p50Pct = bStat.p50 > 0 ? Math.abs(p50Diff / bStat.p50) : 0;

  // If Mann-Whitney says significant
  if (mw.significant) {
    if (p50Diff < 0 && p95Diff <= 0) {
      return { label: "improved", color: G, icon: "+" };
    }
    if (p50Diff < 0 && p95Diff > 0) {
      return { label: "mixed", color: Y, icon: "~" };
    } // p50 better but p95 worse
    if (p50Diff > 0) {
      return { label: "regressed", color: RD, icon: "-" };
    }
  }

  // Not significant
  if (p50Pct < 0.05) {
    return { label: "unchanged", color: D, icon: "=" };
  }

  // Big delta but not enough samples for significance
  return { label: "uncertain", color: Y, icon: "?" };
}

function verdictEmoji(v: Verdict): string {
  switch (v.label) {
    case "improved":
      return "🟢";
    case "regressed":
      return "🔴";
    case "mixed":
      return "🟡";
    case "unchanged":
      return "⚪";
    default:
      return "🟠";
  }
}

function fmtDeltaPlain(current: number, reference: number): string {
  const diff = current - reference;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${fmt(diff)} (${fmtPct(current, reference)})`;
}

function standaloneRunMd(label: string, run: RunStats): string {
  const lines: string[] = [];

  lines.push(`### ${label}`);
  lines.push("");

  if ("End-to-end" in run.phases) {
    const total = run.phases["End-to-end"];
    lines.push(
      `**Overall:** p50: ${fmt(total.p50)} &nbsp;|&nbsp; p95: ${fmt(total.p95)} &nbsp;|&nbsp; cv: ${total.cv.toFixed(2)}`,
    );
    lines.push("");
  }

  const allPhases = ORDERED_PHASES.filter((p) => p in run.phases);

  lines.push("<details>");
  lines.push(`<summary>Phase breakdown</summary>`);
  lines.push("");
  lines.push("| Phase | p50 | p95 | p99 | cv |");
  lines.push("|-------|-----|-----|-----|----|");

  for (const phase of allPhases) {
    const name = phase.replace(/^\s+/, "").trim();
    const s = run.phases[phase];
    lines.push(
      `| ${name} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${s.cv.toFixed(2)} |`,
    );
  }

  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

function compareRunsMd(label: string, base: RunStats, last: RunStats): string {
  const lines: string[] = [];

  lines.push(`### ${label}`);
  lines.push("");

  // Overall summary (always visible)
  if ("End-to-end" in base.phases && "End-to-end" in last.phases) {
    const bTotal = base.phases["End-to-end"];
    const lTotal = last.phases["End-to-end"];
    const verdict = getVerdict(bTotal, lTotal);
    const mw = mannWhitneyU(bTotal.values, lTotal.values);

    lines.push(
      `**Overall:** ${verdictEmoji(verdict)} **${verdict.label}** &nbsp;|&nbsp; ` +
        `p50: ${fmt(bTotal.p50)} → ${fmt(lTotal.p50)} (${fmtPct(lTotal.p50, bTotal.p50)}) &nbsp;|&nbsp; ` +
        `p95: ${fmt(bTotal.p95)} → ${fmt(lTotal.p95)} (${fmtPct(lTotal.p95, bTotal.p95)}) &nbsp;|&nbsp; ` +
        `Mann-Whitney: z=${mw.z.toFixed(2)} ${mw.significant ? "✅ significant" : "not significant"}`,
    );

    if (bTotal.cv > 0.3 || lTotal.cv > 0.3) {
      lines.push("");
      lines.push(
        `> ⚠️ High variance (CV > 0.3) — results may not be reliable.`,
      );
    }
    lines.push("");
  }

  // Detailed table in expandable section
  const allPhases = ORDERED_PHASES.filter(
    (p) => p in base.phases || p in last.phases,
  );

  lines.push("<details>");
  lines.push(`<summary>Phase breakdown</summary>`);
  lines.push("");
  lines.push(
    "| Phase | Base p50 | PR p50 | p50 Δ | Base p95 | PR p95 | p95 Δ | Verdict |",
  );
  lines.push(
    "|-------|----------|--------|-------|----------|--------|-------|---------|",
  );

  for (const phase of allPhases) {
    const hasB = phase in base.phases;
    const hasL = phase in last.phases;
    const name = phase.replace(/^\s+/, "").trim();

    if (!hasB || !hasL) {
      const tag = hasB ? "removed" : "new";
      lines.push(
        `| ${name} | ${hasB ? fmt(base.phases[phase].p50) : "—"} | ${hasL ? fmt(last.phases[phase].p50) : "—"} | ${tag} | — | — | — | — |`,
      );
      continue;
    }

    const bStat = base.phases[phase];
    const lStat = last.phases[phase];
    const verdict = getVerdict(bStat, lStat);

    lines.push(
      `| ${name} | ${fmt(bStat.p50)} | ${fmt(lStat.p50)} | ${fmtDeltaPlain(lStat.p50, bStat.p50)} | ${fmt(bStat.p95)} | ${fmt(lStat.p95)} | ${fmtDeltaPlain(lStat.p95, bStat.p95)} | ${verdictEmoji(verdict)} ${verdict.label} |`,
    );
  }

  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

function standaloneRun(label: string, run: RunStats, verbose: boolean): void {
  const thin = "─".repeat(100);

  if ("End-to-end" in run.phases) {
    const total = run.phases["End-to-end"];
    console.log(
      `  ${B}${label}${R}  ${D}(no baseline)${R}  |  p50: ${fmt(total.p50)}  |  p95: ${fmt(total.p95)}  |  cv: ${total.cv.toFixed(2)}`,
    );
  } else {
    console.log(
      `  ${B}${label}${R}  ${D}(no baseline, no end-to-end data)${R}`,
    );
  }

  if (!verbose) {
    return;
  }

  const allPhases = ORDERED_PHASES.filter((p) => p in run.phases);

  console.log(thin);
  console.log(`  ${run.timestamp} (${String(run.iterations)} runs)`);
  console.log(
    `\n  ${"Phase".padEnd(22)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"p99".padStart(9)}  ${"cv".padStart(5)}`,
  );
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}  ${"─".repeat(5)}`,
  );

  for (const phase of allPhases) {
    const s = run.phases[phase];
    const cv = `${cvColor(s.cv)}${s.cv.toFixed(2)}${R}`;
    console.log(
      `  ${phase.padEnd(22)} ${fmt(s.p50).padStart(9)} ${fmt(s.p95).padStart(9)} ${fmt(s.p99).padStart(9)}  ${cv}`,
    );
  }

  console.log(`\n${thin}`);
}

function compareRuns(
  label: string,
  base: RunStats,
  last: RunStats,
  verbose: boolean,
): void {
  const thin = "─".repeat(140);

  if ("End-to-end" in base.phases && "End-to-end" in last.phases) {
    const bTotal = base.phases["End-to-end"];
    const lTotal = last.phases["End-to-end"];
    const p50Diff = lTotal.p50 - bTotal.p50;
    const p95Diff = lTotal.p95 - bTotal.p95;
    const verdict = getVerdict(bTotal, lTotal);
    const mw = mannWhitneyU(bTotal.values, lTotal.values);

    const p50Color = p50Diff < 0 ? G : p50Diff > 0 ? RD : "";
    const p95Color = p95Diff < 0 ? G : p95Diff > 0 ? RD : "";

    console.log(
      `  ${B}${label}${R}  ${verdict.color}${verdict.icon} ${verdict.label}${R}  |  ` +
        `p50: ${fmt(bTotal.p50)} → ${p50Color}${fmt(lTotal.p50)}${R} (${p50Color}${fmtPct(lTotal.p50, bTotal.p50)}${R})  |  ` +
        `p95: ${fmt(bTotal.p95)} → ${p95Color}${fmt(lTotal.p95)}${R} (${p95Color}${fmtPct(lTotal.p95, bTotal.p95)}${R})  |  ` +
        `Mann-Whitney: z=${mw.z.toFixed(2)} ${mw.significant ? `${G}significant${R}` : `${D}not significant${R}`}`,
    );

    if (bTotal.cv > 0.3 || lTotal.cv > 0.3) {
      console.log(`  ${Y}Warning: CV > 0.3 — results may not be reliable.${R}`);
    }
  } else {
    console.log(`  ${B}${label}${R}  ${D}(no end-to-end data to compare)${R}`);
  }

  if (!verbose) {
    return;
  }

  console.log(thin);
  console.log(
    `  Base: ${base.timestamp} (${String(base.iterations)} runs)    Last: ${last.timestamp} (${String(last.iterations)} runs)`,
  );

  const allPhases = ORDERED_PHASES.filter(
    (p) => p in base.phases || p in last.phases,
  );

  console.log(
    `\n  ${"Phase".padEnd(22)} ${"Base p50".padStart(9)} ${"Last p50".padStart(9)} ${"p50 Δ".padStart(24)}  ${"Base p95".padStart(9)} ${"Last p95".padStart(9)} ${"p95 Δ".padStart(24)}  ${"B cv".padStart(5)} ${"L cv".padStart(5)}  ${"Verdict".padStart(12)}`,
  );
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(24)}  ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(24)}  ${"─".repeat(5)} ${"─".repeat(5)}  ${"─".repeat(12)}`,
  );

  for (const phase of allPhases) {
    const hasB = phase in base.phases;
    const hasL = phase in last.phases;

    if (!hasB || !hasL) {
      const side = hasB ? "removed" : "new";
      console.log(
        `  ${phase.padEnd(22)} ${hasB ? fmt(base.phases[phase].p50).padStart(9) : "—".padStart(9)} ${hasL ? fmt(last.phases[phase].p50).padStart(9) : "—".padStart(9)} ${D}${side.padStart(24)}${R}`,
      );
      continue;
    }

    const bStat = base.phases[phase];
    const lStat = last.phases[phase];

    const p50Delta = fmtDelta(lStat.p50, bStat.p50);
    const p95Delta = fmtDelta(lStat.p95, bStat.p95);
    const verdict = getVerdict(bStat, lStat);

    const bCv = `${cvColor(bStat.cv)}${bStat.cv.toFixed(2)}${R}`;
    const lCv = `${cvColor(lStat.cv)}${lStat.cv.toFixed(2)}${R}`;

    const p50DeltaRaw = `${lStat.p50 - bStat.p50 > 0 ? "+" : ""}${fmt(lStat.p50 - bStat.p50)} (${fmtPct(lStat.p50, bStat.p50)})`;
    const p95DeltaRaw = `${lStat.p95 - bStat.p95 > 0 ? "+" : ""}${fmt(lStat.p95 - bStat.p95)} (${fmtPct(lStat.p95, bStat.p95)})`;
    const p50Pad = 24 - p50DeltaRaw.length;
    const p95Pad = 24 - p95DeltaRaw.length;

    console.log(
      `  ${phase.padEnd(22)} ${fmt(bStat.p50).padStart(9)} ${fmt(lStat.p50).padStart(9)} ${" ".repeat(Math.max(0, p50Pad))}${p50Delta}  ${fmt(bStat.p95).padStart(9)} ${fmt(lStat.p95).padStart(9)} ${" ".repeat(Math.max(0, p95Pad))}${p95Delta}  ${bCv} ${lCv}  ${verdict.color}${(verdict.icon + " " + verdict.label).padStart(12)}${R}`,
    );
  }

  if ("End-to-end" in base.phases && "End-to-end" in last.phases) {
    const bTotal = base.phases["End-to-end"];
    const lTotal = last.phases["End-to-end"];

    console.log(
      `\n  ${D}Base runs:  [${bTotal.values.map((v) => fmt(v)).join(", ")}]${R}`,
    );
    console.log(
      `  ${D}Last runs:  [${lTotal.values.map((v) => fmt(v)).join(", ")}]${R}`,
    );
  }

  console.log(`\n${thin}`);
}

const markdown = process.argv.includes("--markdown");
const verbose = process.argv.includes("--verbose");

const base = loadJson(BASE_FILE);
const last = loadJson(LAST_FILE);

if (!base) {
  console.error("No base results found. Run: npm run test:perf:base");
  process.exit(1);
}

if (!last) {
  console.error("No last results found. Run: npm run test:perf");
  process.exit(1);
}

if (markdown) {
  const sections: string[] = [];
  sections.push("## ⚡ Performance Report");
  sections.push("");
  sections.push(compareRunsMd("Cold Start", base.cold, last.cold));
  if (
    base.warm !== null &&
    base.warm !== undefined &&
    last.warm !== null &&
    last.warm !== undefined
  ) {
    sections.push("");
    sections.push(compareRunsMd("Warm Start", base.warm, last.warm));
  } else if (last.warm !== null && last.warm !== undefined) {
    sections.push("");
    sections.push(standaloneRunMd("Warm Start", last.warm));
  }
  if (
    base.lukewarm !== null &&
    base.lukewarm !== undefined &&
    last.lukewarm !== null &&
    last.lukewarm !== undefined
  ) {
    sections.push("");
    sections.push(
      compareRunsMd(
        "Lukewarm Start (different site, same session)",
        base.lukewarm,
        last.lukewarm,
      ),
    );
  } else if (last.lukewarm !== null && last.lukewarm !== undefined) {
    sections.push("");
    sections.push(
      standaloneRunMd(
        "Lukewarm Start (different site, same session)",
        last.lukewarm,
      ),
    );
  }
  sections.push("");
  sections.push(
    (() => {
      const sha = process.env.GITHUB_SHA;
      const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
      const repo = process.env.GITHUB_REPOSITORY ?? "";
      const commitRef =
        sha !== undefined && sha !== "" && repo !== ""
          ? `[${sha.slice(0, 7)}](${server}/${repo}/commit/${sha})`
          : "local";
      return `<sub>Commit: ${commitRef} &nbsp;|&nbsp; Outliers (>2x best) discarded before stats</sub>`;
    })(),
  );
  console.log(sections.join("\n"));
} else {
  console.log(`\n  ${B}dot.li Performance Comparison: Base vs Last${R}`);
  if (!verbose) {
    console.log(`  ${D}Use --verbose for detailed phase breakdown${R}`);
  }
  console.log("");

  compareRuns("COLD START", base.cold, last.cold, verbose);

  if (
    base.warm !== null &&
    base.warm !== undefined &&
    last.warm !== null &&
    last.warm !== undefined
  ) {
    compareRuns("WARM START", base.warm, last.warm, verbose);
  } else if (last.warm !== null && last.warm !== undefined) {
    standaloneRun("WARM START", last.warm, verbose);
  }

  if (
    base.lukewarm !== null &&
    base.lukewarm !== undefined &&
    last.lukewarm !== null &&
    last.lukewarm !== undefined
  ) {
    compareRuns(
      "LUKEWARM START (different site, same session)",
      base.lukewarm,
      last.lukewarm,
      verbose,
    );
  } else if (last.lukewarm !== null && last.lukewarm !== undefined) {
    standaloneRun(
      "LUKEWARM START (different site, same session)",
      last.lukewarm,
      verbose,
    );
  }
}
