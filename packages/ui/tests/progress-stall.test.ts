import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancePhase,
  initPhases,
  nudgePhaseProgress,
  onProgressStall,
  stopProgressWatch,
  type LoadingPhase,
} from "@dotli/ui/ui";

// Mirror of PROGRESS_STALL_MS in ui.ts.
const STALL_MS = 4_000;

const PHASES: LoadingPhase[] = [
  {
    label: "Starting",
    base: 0,
    target: 10,
    expectedMs: 500,
    stage: "starting",
  },
  {
    label: "Fetching content",
    base: 10,
    target: 90,
    expectedMs: 10_000,
    stage: "content",
    reportsProgress: true,
  },
];

function installLoadingDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div class="loading">
        <div class="loading-progress" id="loading-progress">
          <div class="loading-progress-fill" id="loading-progress-fill"></div>
          <span class="loading-progress-pct" id="loading-progress-pct">0%</span>
        </div>
        <p id="status"></p>
        <p class="sr-only" id="status-sr"></p>
      </div>
    </div>`;
}

describe("The loading bar reports when it stops moving", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installLoadingDom();
  });

  afterEach(() => {
    stopProgressWatch();
    onProgressStall(() => {});
    vi.useRealTimers();
  });

  it("As a user whose load has parked, I am told the percentage it stuck at", () => {
    // Given
    const stalls: number[] = [];
    initPhases(PHASES);
    onProgressStall((pct) => {
      stalls.push(pct);
    });

    // When
    advancePhase(1);
    vi.advanceTimersByTime(STALL_MS + 100);

    // Then
    expect(stalls.length).toBe(1);
    expect(Math.round(stalls[0])).toBeGreaterThanOrEqual(10);
  });

  it("As a user whose load is still moving, I am not warned", () => {
    // Given
    const stalls: number[] = [];
    initPhases(PHASES);
    onProgressStall((pct) => {
      stalls.push(pct);
    });
    advancePhase(1);

    // When
    // A real report every second, which is what a healthy download looks like.
    for (let i = 1; i <= 6; i += 1) {
      vi.advanceTimersByTime(1_000);
      nudgePhaseProgress(i / 10, "content");
    }

    // Then
    expect(stalls).toEqual([]);
  });

  it("As a user whose load recovers then parks again, I am warned each time", () => {
    // Given
    const stalls: number[] = [];
    initPhases(PHASES);
    onProgressStall((pct) => {
      stalls.push(pct);
    });
    advancePhase(1);

    // When
    vi.advanceTimersByTime(STALL_MS + 100);
    nudgePhaseProgress(0.5, "content");
    vi.advanceTimersByTime(STALL_MS + 100);

    // Then
    expect(stalls.length).toBe(2);
    expect(stalls[1]).toBeGreaterThan(stalls[0]);
  });

  it("As a user whose load finished, I am never warned about a full bar", () => {
    // Given
    const stalls: number[] = [];
    initPhases(PHASES);
    onProgressStall((pct) => {
      stalls.push(pct);
    });

    // When
    advancePhase(1);
    nudgePhaseProgress(1, "content");
    stopProgressWatch();
    vi.advanceTimersByTime(STALL_MS * 3);

    // Then
    expect(stalls).toEqual([]);
  });
});
