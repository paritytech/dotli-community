// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let initPhases: typeof import("@dotli/ui/ui").initPhases;
let advancePhase: typeof import("@dotli/ui/ui").advancePhase;
let showStatus: typeof import("@dotli/ui/ui").showStatus;
let setStatusDetail: typeof import("@dotli/ui/ui").setStatusDetail;

const PHASES = [
  { label: "Starting", base: 2, target: 6, expectedMs: 650 },
  { label: "Adding relay chain", base: 6, target: 10, expectedMs: 120 },
  { label: "Syncing Asset Hub", base: 10, target: 55, expectedMs: 6500 },
];

function textOf(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

beforeEach(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <div id="app">
      <div class="loading">
        <div id="loading-progress-fill"></div>
        <span id="loading-progress-pct">0%</span>
        <p id="status">Reaching out</p>
        <p id="loading-detail" aria-hidden="true"></p>
        <p id="loading-hint"></p>
      </div>
    </div>`;
  vi.resetModules();
  const mod = await import("@dotli/ui/ui");
  initPhases = mod.initPhases;
  advancePhase = mod.advancePhase;
  showStatus = mod.showStatus;
  setStatusDetail = mod.setStatusDetail;
  initPhases(PHASES);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("setStatusDetail", () => {
  it("writes the detail line without touching the status headline", () => {
    showStatus("Resolving example.dot");
    setStatusDetail("3 peers");
    expect(textOf("loading-detail")).toBe("3 peers");
    expect(textOf("status")).toBe("Resolving example.dot");
  });

  it("does not reset the slow-hint timer while the count updates", () => {
    advancePhase(2);
    // "Syncing Asset Hub" arms a 15s hint. A peer count that ticks every
    // second must not keep pushing that hint away.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      setStatusDetail(`${String(i)} peers`);
    }
    expect(textOf("loading-hint")).toContain("Asset Hub sync is slow");
  });
});

describe("advancePhase", () => {
  it("re-arms the slow hint for the new phase label", () => {
    showStatus("Adding Paseo relay chain...");
    advancePhase(2);
    // The relay-chain hint (10s) must not fire after we advanced to the
    // Syncing phase; the Syncing hint (15s) fires instead.
    vi.advanceTimersByTime(11_000);
    expect(textOf("loading-hint")).not.toContain("relay chain bootstrap");
    vi.advanceTimersByTime(4_000);
    expect(textOf("loading-hint")).toContain("Asset Hub sync is slow");
  });

  it("keeps the detail line across phase advances", () => {
    setStatusDetail("4 peers");
    advancePhase(2);
    expect(textOf("loading-detail")).toBe("4 peers");
  });
});
