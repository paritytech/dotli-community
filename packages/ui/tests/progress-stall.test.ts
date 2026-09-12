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

describe("The loading bar never stands still", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installLoadingDom();
  });

  afterEach(() => {
    stopProgressWatch();
    vi.useRealTimers();
  });

  function shownPercent(): number {
    return Number(
      (
        document.getElementById("loading-progress-pct")?.textContent ?? "0%"
      ).replace("%", ""),
    );
  }

  it("As a user whose download reports nothing at all, the number still moves every 3 seconds", () => {
    // Given a step that promised a real percentage and never delivers one,
    // which is what a peerless content chain looks like.
    initPhases(PHASES);
    advancePhase(1);

    // When
    const seen: number[] = [shownPercent()];
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(3_000);
      seen.push(shownPercent());
    }

    // Then no two consecutive samples three seconds apart are equal
    const frozen = seen.filter((v, i) => i > 0 && v === seen[i - 1]);
    expect(frozen).toEqual([]);
  });

  it("As a user, the creeping number never claims more than the step it is in", () => {
    // Given
    initPhases(PHASES);
    advancePhase(1);

    // When a very long silence, far longer than the band's runway
    vi.advanceTimersByTime(10 * 60_000);

    // Then it stops at the band's own target rather than implying the load is done
    expect(shownPercent()).toBeLessThanOrEqual(PHASES[1].target);
  });

  it("As a user whose real progress overtakes the creep, the number follows the truth", () => {
    // Given
    initPhases(PHASES);
    advancePhase(1);
    vi.advanceTimersByTime(9_000);
    const crept = shownPercent();

    // When a real report arrives well ahead of where the creep had reached
    nudgePhaseProgress(0.9, "content");

    // Then
    expect(shownPercent()).toBeGreaterThan(crept);
  });
});
