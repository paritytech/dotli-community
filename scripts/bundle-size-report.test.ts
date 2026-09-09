// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "bun:test";
import { formatBytes, formatDelta, stripHash } from "./dist-sizes.ts";
import {
  isoWeek,
  isoWeekStart,
  previousWeek,
  chartScale,
  renderBudgets,
  renderChart,
  renderTrendTable,
  selectChartPoints,
  selectTableRows,
  upsertEntry,
  yAxisRange,
  type Entry,
} from "./bundle-size-report.ts";

function entry(week: string, date: string, br: number, sha = "abc1234"): Entry {
  return {
    week,
    date,
    sha,
    total: { raw: br * 3, br, gz: br * 1.2 },
    apps: { host: { raw: br * 3, br, gz: br * 1.2 } },
  };
}

function series(count: number): Entry[] {
  const entries: Entry[] = [];
  const cursor = isoWeekStart("2025-W01");
  for (let i = 0; i < count; i++) {
    const week = isoWeek(cursor);
    entries.push(
      entry(week, cursor.toISOString().slice(0, 10), 1000000 + i * 1000),
    );
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return entries;
}

describe("stripHash", () => {
  test("strips a vite content hash", () => {
    expect(stripHash("host/assets/index-CMRV9u5T.js")).toBe(
      "host/assets/index.js",
    );
  });

  test("leaves an unhashed name alone", () => {
    expect(stripHash("host/index.html")).toBe("host/index.html");
  });

  test("leaves a short suffix alone", () => {
    expect(stripHash("host/assets/logo-dark.svg")).toBe(
      "host/assets/logo-dark.svg",
    );
  });
});

describe("formatBytes", () => {
  test.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1048575, "1024.0 KB"],
    [1048576, "1.00 MB"],
  ])("%i renders as %s", (bytes: number, expected: string) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatDelta", () => {
  test("is empty without a baseline", () => {
    expect(formatDelta(2048)).toBe("");
  });

  test("is empty when unchanged", () => {
    expect(formatDelta(2048, 2048)).toBe("");
  });

  test("signs growth and shrinkage", () => {
    expect(formatDelta(3072, 2048)).toBe("+1.0 KB");
    expect(formatDelta(1024, 2048)).toBe("-1.0 KB");
  });
});

describe("iso weeks", () => {
  test("resolves a known date", () => {
    expect(isoWeek(new Date("2026-09-04T00:00:00Z"))).toBe("2026-W36");
  });

  test("round-trips through the week start", () => {
    expect(isoWeek(isoWeekStart("2026-W36"))).toBe("2026-W36");
  });

  test("steps back across a year boundary", () => {
    expect(previousWeek("2026-W01")).toBe("2025-W52");
  });
});

describe("upsertEntry", () => {
  test("replaces a same-week entry rather than appending", () => {
    const entries = [entry("2026-W36", "2026-09-04", 1000)];
    const updated = upsertEntry(entries, entry("2026-W36", "2026-09-05", 2000));
    expect(updated).toHaveLength(1);
    expect(updated[0].total.br).toBe(2000);
  });

  test("keeps entries sorted by week", () => {
    const entries = upsertEntry(
      [entry("2026-W36", "2026-09-04", 1000)],
      entry("2026-W33", "2026-08-14", 900),
    );
    expect(entries.map((e) => e.week)).toEqual(["2026-W33", "2026-W36"]);
  });
});

describe("selectChartPoints", () => {
  test("returns everything under the cap", () => {
    expect(selectChartPoints(series(5), 24)).toHaveLength(5);
  });

  test("keeps the most recent points at the cap", () => {
    const points = selectChartPoints(series(40), 24);
    expect(points).toHaveLength(24);
    expect(points[23].week).toBe(series(40)[39].week);
  });
});

describe("selectTableRows", () => {
  test("returns everything when short", () => {
    expect(selectTableRows(series(5))).toHaveLength(5);
  });

  test("keeps the recent weeks, a row per earlier month, and the origin", () => {
    const entries = series(61);
    const rows = selectTableRows(entries);
    const weeks = rows.map((r) => r.week);
    expect(weeks).toContain(entries[0].week);
    for (const recent of entries.slice(-12)) {
      expect(weeks).toContain(recent.week);
    }
    expect(rows.length).toBeLessThan(entries.length);
  });

  test("is newest first and free of duplicates", () => {
    const rows = selectTableRows(series(61));
    const weeks = rows.map((r) => r.week);
    expect(new Set(weeks).size).toBe(weeks.length);
    expect([...weeks].sort((a, b) => b.localeCompare(a))).toEqual(weeks);
  });
});

describe("yAxisRange", () => {
  test("pads around the data", () => {
    const [low, high] = yAxisRange([1000, 1050]);
    expect(low).toBeLessThan(1000);
    expect(high).toBeGreaterThan(1050);
  });

  test("never returns a zero-height axis", () => {
    const [low, high] = yAxisRange([1000, 1000]);
    expect(high).toBeGreaterThan(low);
  });
});

describe("chartScale", () => {
  test("stays in KB for a small bundle", () => {
    expect(chartScale(900 * 1024).unit).toBe("KB");
  });

  test("switches to MB once the bundle is large", () => {
    expect(chartScale(18 * 1024 * 1024).unit).toBe("MB");
  });
});

describe("renderChart", () => {
  test("emits no fence with no entries", () => {
    expect(renderChart([])).not.toContain("```mermaid");
  });

  test("emits no fence with one entry", () => {
    expect(renderChart(series(1))).not.toContain("```mermaid");
  });

  test("emits a fence with two entries", () => {
    expect(renderChart(series(2))).toContain("xychart-beta");
  });

  test("labels the axis in the scale it plots", () => {
    const chart = renderChart(series(2));
    expect(chart).toContain('y-axis "KB"');
  });

  test("plots at most the cap", () => {
    const chart = renderChart(series(40), 24);
    const line = chart.split("\n").find((l) => l.includes("line ["))!;
    expect(line.split(",")).toHaveLength(24);
  });
});

describe("renderTrendTable", () => {
  test("leaves change empty on the oldest row", () => {
    const table = renderTrendTable(series(3), "paritytech/dotli-community");
    const rows = table.split("\n").filter((l) => l.startsWith("| 20"));
    expect(rows[rows.length - 1].endsWith("|  |")).toBe(true);
  });

  test("links each commit absolutely", () => {
    const table = renderTrendTable(series(2), "paritytech/dotli-community");
    expect(table).toContain(
      "https://github.com/paritytech/dotli-community/commit/abc1234",
    );
  });
});

describe("renderBudgets", () => {
  test("is a plain line when inside budget", () => {
    const line = renderBudgets([
      { label: "host-entry", size: 471244, max: 614400, over: false },
    ]);
    expect(line).toStartWith("_Entry budgets:");
  });

  test("raises a callout when over budget", () => {
    const line = renderBudgets([
      { label: "host-entry", size: 714400, max: 614400, over: true },
    ]);
    expect(line).toContain("> [!WARNING]");
  });
});
