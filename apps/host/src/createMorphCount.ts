// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Answers whether any of the bar's transitions still run. */
  areTransitionsRunning: () => boolean;
};

/**
 * Builds a count of the bar's own running transitions, so what is laid out against its box waits for the morph to end.
 * An engine may drop a transition without its end or cancel event, so a count is cleared once none of the bar's
 * transitions runs, rather than freezing layout for good.
 */
export function createMorphCount({ areTransitionsRunning }: Params) {
  let morphs = 0;

  function clearDropped(): void {
    if (morphs > 0 && !areTransitionsRunning()) {
      morphs = 0;
    }
  }

  return {
    /** Counts a morph that started. */
    start(): void {
      morphs += 1;
    },
    /**
     * Returns true when this ended the last running morph. An end with none running is ignored. Throws only as
     * `areTransitionsRunning` does.
     */
    end(): boolean {
      if (morphs === 0) {
        return false;
      }
      morphs -= 1;
      clearDropped();
      return morphs === 0;
    },
    /** Returns whether a morph still runs. Throws only as `areTransitionsRunning` does. */
    isRunning(): boolean {
      clearDropped();
      return morphs > 0;
    },
    /** Clears the count. */
    reset(): void {
      morphs = 0;
    },
  };
}
