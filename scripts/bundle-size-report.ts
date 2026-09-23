// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Generates docs/bundle-size.md and maintains its history sidecar.
// Run with: bun scripts/bundle-size-report.ts --record

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  collectDistSizes,
  formatBytes,
  formatDelta,
  formatKb,
  sumSizes,
  type FileSizes,
  type Sizes,
} from "./dist-sizes.ts";

const DEFAULT_DISTS = ["apps/host/dist", "apps/sandbox/dist"];
const DEFAULT_HISTORY = "docs/assets/bundle-size-history.json";
const DEFAULT_OUT = "docs/bundle-size.md";
const MAX_POINTS = 24;
const RECENT_ROWS = 12;
const TOP_FILES = 15;
const FALLBACK_REPO = "paritytech/dotli-community";

// The protocol iframe must not bundle smoldot or chain specs: doing so inflates
// RPC-mode cold start by ~3 MB. The host entry sits at ~460 KB raw, so 600 KB
// leaves headroom while still catching a real regression.
const BUDGETS = [
  { label: "protocol-iframe-entry", app: "protocol", max: 600 * 1024 },
  { label: "host-entry", app: "host", max: 600 * 1024 },
];

export interface Entry {
  week: string;
  date: string;
  sha: string;
  total: Sizes;
  apps: Record<string, Sizes>;
}

export interface History {
  version: number;
  entries: Entry[];
  latest: { sha: string; files: Record<string, Sizes> };
}

export interface BudgetResult {
  label: string;
  size?: number;
  max: number;
  over: boolean;
}

export function isoWeek(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function isoWeekStart(week: string): Date {
  const [year, number] = week.split("-W");
  const jan4 = new Date(Date.UTC(Number(year), 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1);
  monday.setUTCDate(monday.getUTCDate() + (Number(number) - 1) * 7);
  return monday;
}

export function isoWeekEnd(week: string): Date {
  const end = isoWeekStart(week);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}

export function previousWeek(week: string): string {
  const start = isoWeekStart(week);
  start.setUTCDate(start.getUTCDate() - 7);
  return isoWeek(start);
}

export function upsertEntry(entries: Entry[], entry: Entry): Entry[] {
  const kept = entries.filter((e) => e.week !== entry.week);
  return [...kept, entry].sort((a, b) => a.week.localeCompare(b.week));
}

export function selectChartPoints(entries: Entry[], max = MAX_POINTS): Entry[] {
  return entries.slice(-max);
}

export function selectTableRows(entries: Entry[]): Entry[] {
  if (entries.length === 0) return [];
  const picked = new Map<string, Entry>();
  for (const entry of entries.slice(-RECENT_ROWS)) {
    picked.set(entry.week, entry);
  }
  const byMonth = new Map<string, Entry>();
  for (const entry of entries.slice(0, -RECENT_ROWS)) {
    byMonth.set(entry.date.slice(0, 7), entry);
  }
  for (const entry of byMonth.values()) {
    picked.set(entry.week, entry);
  }
  picked.set(entries[0].week, entries[0]);
  return [...picked.values()].sort((a, b) => b.week.localeCompare(a.week));
}

function niceStep(target: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const scaled = target / magnitude;
  const rounded = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return rounded * magnitude;
}

// The step has to follow the data, not a fixed constant: the same 50-unit
// rounding that reads well over ~1000 KB collapses an 8-to-18 MB series onto a
// 0-to-50 axis.
export function yAxisRange(values: number[]): [number, number] {
  const low = Math.min(...values) * 0.92;
  const high = Math.max(...values) * 1.08;
  const step = niceStep(Math.max((high - low) / 4, high * 0.02));
  const bottom = Math.floor(low / step) * step;
  const top = Math.ceil(high / step) * step;
  return [
    Number(bottom.toFixed(2)),
    Number((top > bottom ? top : bottom + step).toFixed(2)),
  ];
}

export interface Scale {
  unit: "KB" | "MB";
  of: (bytes: number) => number;
  format: (bytes: number) => string;
}

export function formatInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function chartScale(maxBytes: number): Scale {
  if (maxBytes >= 4 * 1024 * 1024) {
    return {
      unit: "MB",
      of: (b) => Number((b / 1024 / 1024).toFixed(2)),
      format: (b) => `${(b / 1024 / 1024).toFixed(2)} MB`,
    };
  }
  return {
    unit: "KB",
    of: (b) => Number((b / 1024).toFixed(1)),
    format: formatKb,
  };
}

export function renderChart(entries: Entry[], max = MAX_POINTS): string {
  const points = selectChartPoints(entries, max);
  if (points.length < 2) {
    return "_The chart appears once a second week has been recorded._";
  }
  const scale = chartScale(Math.max(...entries.map((e) => e.total.br)));
  const values = points.map((e) => scale.of(e.total.br));
  const [low, high] = yAxisRange(values);
  const labels = points.map((e) => `"${e.date.slice(5, 10)}"`).join(", ");
  return [
    "```mermaid",
    "xychart-beta",
    `    title "Evolution of served bundle size in the last ${points.length} weeks"`,
    `    x-axis [${labels}]`,
    `    y-axis "${scale.unit}" ${low} --> ${high}`,
    `    line [${values.join(", ")}]`,
    "```",
  ].join("\n");
}

export function renderTrendTable(entries: Entry[], repo: string): string {
  const rows = selectTableRows(entries);
  const scale = chartScale(Math.max(...entries.map((e) => e.total.br)));
  const lines = [
    "| Snapshot | Commit | Total brotli | Change |",
    "| --- | --- | ---: | ---: |",
  ];
  // Against the row below, not the previous week: once the older rows are
  // sampled monthly, a week-over-week delta contradicts the two totals either
  // side of it.
  for (const [index, entry] of rows.entries()) {
    const previous = rows[index + 1];
    const change = previous
      ? formatDelta(entry.total.br, previous.total.br)
      : "";
    const link = `[\`${entry.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${entry.sha})`;
    lines.push(
      `| ${formatInstant(entry.date)} | ${link} | ${scale.format(entry.total.br)} | ${change} |`,
    );
  }
  lines.push("");
  lines.push(
    `_Showing ${rows.length} of ${entries.length} recorded weeks. Full history in \`assets/bundle-size-history.json\`._`,
  );
  return lines.join("\n");
}

function fileRows(
  files: FileSizes[],
  previous: Record<string, Sizes>,
  apps: Record<string, Sizes>,
  total: Sizes,
): string[] {
  const lines = [
    "| File | Raw | Brotli | Gzip | Change |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const file of files) {
    const change = formatDelta(file.br, previous[file.name]?.br);
    lines.push(
      `| \`${file.name}\` | ${formatBytes(file.raw)} | ${formatBytes(file.br)} | ${formatBytes(file.gz)} | ${change} |`,
    );
  }
  for (const app of Object.keys(apps).sort()) {
    const sizes = apps[app];
    lines.push(
      `| **${app}** | ${formatBytes(sizes.raw)} | ${formatBytes(sizes.br)} | ${formatBytes(sizes.gz)} | |`,
    );
  }
  const saving = ((1 - total.br / total.raw) * 100).toFixed(0);
  lines.push(
    `| **Total** | **${formatBytes(total.raw)}** | **${formatBytes(total.br)}** (-${saving}%) | **${formatBytes(total.gz)}** | |`,
  );
  return lines;
}

export function renderFileTable(
  files: FileSizes[],
  previous: Record<string, Sizes>,
  apps: Record<string, Sizes>,
  total: Sizes,
): string {
  const ranked = [...files].sort((a, b) => b.br - a.br);
  const lines = fileRows(ranked.slice(0, TOP_FILES), previous, apps, total);
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>All files</summary>");
  lines.push("");
  lines.push(...fileRows(ranked, previous, apps, total));
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

export function renderBudgets(results: BudgetResult[]): string {
  if (results.length === 0) return "";
  const breached = results.filter((r) => r.over || r.size === undefined);
  const summary = results
    .map((r) =>
      r.size === undefined
        ? `\`${r.label}\` not found`
        : `\`${r.label}\` ${formatBytes(r.size)} / ${formatBytes(r.max)}`,
    )
    .join(", ");
  if (breached.length === 0) {
    return `_Entry budgets: ${summary}._`;
  }
  return [
    "> [!WARNING]",
    "> **Bundle budget exceeded.** Not a blocker, but confirm the regression is intentional.",
    ">",
    ...breached.map((r) =>
      r.size === undefined
        ? `> - \`${r.label}\`: no entry chunk found.`
        : `> - \`${r.label}\`: **${formatBytes(r.size)}** over a ${formatBytes(r.max)} budget.`,
    ),
    "",
    `_Entry budgets: ${summary}._`,
  ].join("\n");
}

export function renderReport(
  history: History,
  files: FileSizes[],
  previous: Record<string, Sizes>,
  budgets: BudgetResult[],
  repo: string,
  generatedAt: string,
): string {
  const entries = history.entries;
  const current = entries[entries.length - 1];
  const first = entries[0];
  const drift =
    entries.length > 1 ? formatDelta(current.total.br, first.total.br) : "";
  const since = drift
    ? `Since the first record (${first.date.slice(0, 10)}): **${drift}**.`
    : `First record: ${first.date.slice(0, 10)}.`;

  return [
    "# Bundle size",
    "",
    `_Last updated ${formatInstant(generatedAt)}._`,
    "",
    renderChart(entries),
    "",
    "## Trend",
    "",
    renderTrendTable(entries, repo),
    "",
    `## Latest files at \`${current.sha.slice(0, 7)}\``,
    "",
    renderBudgets(budgets),
    "",
    renderFileTable(files, previous, current.apps, current.total),
    "",
    "## Notes",
    "",
    "Generated by `scripts/bundle-size-report.ts`. Do not edit by hand.",
    "",
    "Measured on `main` at the last merge of each week, across `apps/host/dist` and",
    "`apps/sandbox/dist`. Sizes are bytes served: brotli where a `.br` sidecar exists",
    "and raw otherwise, matching `brotli_static on` in",
    "`nginx/snippets/dotli-precompressed.conf`.",
    "",
    since,
    "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

async function checkBudgets(): Promise<BudgetResult[]> {
  const results: BudgetResult[] = [];
  for (const budget of BUDGETS) {
    const dir = `apps/${budget.app}/dist/assets`;
    let size: number | undefined;
    try {
      const names = await readdir(dir);
      const entry = names.find(
        (n) => n.startsWith("index-") && n.endsWith(".js"),
      );
      if (entry) {
        size = (await stat(join(dir, entry))).size;
      }
    } catch {
      size = undefined;
    }
    const over = size !== undefined && size > budget.max;
    if (size === undefined) {
      console.log(`::warning::${budget.label}: no entry chunk found in ${dir}`);
    } else if (over) {
      console.log(
        `::warning::${budget.label} exceeded budget: ${size} B > ${budget.max} B`,
      );
    } else {
      console.log(`${budget.label}: ${size} B (budget ${budget.max} B) — ok`);
    }
    results.push({ label: budget.label, size, max: budget.max, over });
  }
  return results;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function commitInstant(sha: string): string {
  return new Date(git("show", "-s", "--format=%cI", sha)).toISOString();
}

function repoSlug(): string {
  try {
    const url = git("remote", "get-url", "origin");
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return match ? match[1] : FALLBACK_REPO;
  } catch {
    return FALLBACK_REPO;
  }
}

// Excludes the generated files so a week whose last merge is the report PR
// itself still records the commit that actually changed the bundle.
export function resolveWeekSha(week: string): string | undefined {
  const before = isoWeekEnd(week).toISOString();
  const sha = git(
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${before}`,
    "origin/main",
    "--",
    `:(exclude)${DEFAULT_OUT}`,
    `:(exclude)${DEFAULT_HISTORY}`,
  );
  return sha || undefined;
}

async function readHistory(path: string): Promise<History> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as History;
  } catch {
    return { version: 1, entries: [], latest: { sha: "", files: {} } };
  }
}

async function measure(dists: string[]): Promise<{
  files: FileSizes[];
  apps: Record<string, Sizes>;
  total: Sizes;
}> {
  const files: FileSizes[] = [];
  const apps: Record<string, Sizes> = {};
  for (const dist of dists) {
    const app = dist.split("/")[1];
    const collected = await collectDistSizes(dist, app);
    apps[app] = sumSizes(collected);
    files.push(...collected);
  }
  return { files, apps, total: sumSizes(files) };
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function record(
  historyPath: string,
  outPath: string,
  dists: string[],
  week: string,
  sha: string,
  date: string,
  generatedAt: string,
): Promise<void> {
  const history = await readHistory(historyPath);
  const existing = history.entries.find((e) => e.week === week);
  if (existing && existing.sha === sha) {
    console.log(
      `${week} already recorded at ${sha.slice(0, 7)}, nothing to do`,
    );
    return;
  }

  const previous = history.latest.files;
  const { files, apps, total } = await measure(dists);
  history.entries = upsertEntry(history.entries, {
    week,
    date,
    sha,
    total,
    apps,
  });
  history.latest = {
    sha,
    files: Object.fromEntries(
      files.map((f) => [f.name, { raw: f.raw, br: f.br, gz: f.gz }]),
    ),
  };

  const budgets = await checkBudgets();
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  await writeFile(
    outPath,
    renderReport(history, files, previous, budgets, repoSlug(), generatedAt),
  );
  console.log(
    `Recorded ${week} at ${sha.slice(0, 7)}: ${formatBytes(total.br)}`,
  );
}

async function renderOnly(historyPath: string, outPath: string): Promise<void> {
  const history = await readHistory(historyPath);
  if (history.entries.length === 0) {
    throw new Error(`no entries in ${historyPath}`);
  }
  const files: FileSizes[] = Object.entries(history.latest.files).map(
    ([name, sizes]) => ({ name, ...sizes }),
  );
  await writeFile(
    outPath,
    renderReport(history, files, {}, [], repoSlug(), new Date().toISOString()),
  );
  console.log(`Rendered ${outPath} from ${history.entries.length} entries`);
}

function backfillWeeks(): string[] {
  const first = git(
    "log",
    "--first-parent",
    "--reverse",
    "--format=%cI",
    "origin/main",
  ).split("\n")[0];
  const weeks: string[] = [];
  const cursor = isoWeekStart(isoWeek(new Date(first)));
  const stop = isoWeekStart(isoWeek(new Date()));
  while (cursor < stop) {
    weeks.push(isoWeek(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  const recent = new Set(weeks.slice(-MAX_POINTS));
  const monthly = new Map<string, string>();
  for (const week of weeks) {
    monthly.set(isoWeekStart(week).toISOString().slice(0, 7), week);
  }
  const wanted = new Set([weeks[0], ...monthly.values(), ...recent]);
  return weeks.filter((w) => wanted.has(w));
}

async function backfill(historyPath: string, outPath: string, dists: string[]) {
  if (git("status", "--porcelain")) {
    throw new Error(
      "working tree is dirty, refusing to check out other commits",
    );
  }
  const original = git("rev-parse", "--abbrev-ref", "HEAD");
  try {
    for (const week of backfillWeeks()) {
      const sha = resolveWeekSha(week);
      if (!sha) {
        console.log(`${week}: no commit, skipping`);
        continue;
      }
      console.log(`${week}: building ${sha.slice(0, 7)}`);
      try {
        git("checkout", "--quiet", sha);
        execFileSync("bun", ["install", "--frozen-lockfile"], {
          stdio: "inherit",
        });
        execFileSync("bunx", ["--bun", "turbo", "run", "build:prod"], {
          stdio: "inherit",
        });
      } catch {
        console.log(`::warning::${week}: build failed, skipping`);
        continue;
      }
      const date = commitInstant(sha);
      await record(
        historyPath,
        outPath,
        dists,
        week,
        sha,
        date,
        new Date().toISOString(),
      );
    }
  } finally {
    git("checkout", "--quiet", original);
  }
}

async function main(): Promise<void> {
  const historyPath = arg("history", DEFAULT_HISTORY)!;
  const outPath = arg("out", DEFAULT_OUT)!;
  const dists = (arg("dists") ?? DEFAULT_DISTS.join(",")).split(",");

  if (flag("budget-only")) {
    await checkBudgets();
    return;
  }
  if (flag("render-only")) {
    await renderOnly(historyPath, outPath);
    return;
  }
  if (flag("backfill")) {
    await backfill(historyPath, outPath, dists);
    return;
  }
  if (flag("print-week") || flag("print-sha")) {
    const week = arg("week") ?? previousWeek(isoWeek(new Date()));
    console.log(flag("print-week") ? week : (resolveWeekSha(week) ?? ""));
    return;
  }
  if (flag("record")) {
    const week = arg("week") ?? previousWeek(isoWeek(new Date()));
    const sha = arg("sha") ?? resolveWeekSha(week);
    if (!sha) {
      console.log(`${week}: no commit on main, nothing to record`);
      return;
    }
    const date = arg("date") ?? commitInstant(sha);
    await record(
      historyPath,
      outPath,
      dists,
      week,
      sha,
      date,
      new Date().toISOString(),
    );
    return;
  }

  console.error(
    "usage: bundle-size-report.ts --record | --budget-only | --render-only | --backfill | --print-week | --print-sha",
  );
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
