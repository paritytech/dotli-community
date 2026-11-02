// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Answers whether any of the bar's transitions still run, or undefined where the engine cannot say. */
  areTransitionsRunning: () => boolean | undefined;
};

/**
 * Builds a count of the bar's own running transitions, so what is laid out against its box waits for the morph to end.
 * An engine may drop a transition without its end or cancel event, so a count with none running is cleared rather than
 * freezing layout for good. Never throws.
 */
export function createMorphCount({ areTransitionsRunning }: Params) {
  let morphs = 0;
  return {
    /** Counts a morph that started. Never throws. */
    start(): void {
      morphs += 1;
    },
    /** Returns true when this ended the last running morph. An end with none running is ignored. Never throws. */
    end(): boolean {
      if (morphs === 0) {
        return false;
      }
      morphs -= 1;
      return morphs === 0;
    },
    /** Returns whether a morph still runs. Throws only as `areTransitionsRunning` does. */
    isRunning(): boolean {
      if (morphs > 0 && areTransitionsRunning() === false) {
        morphs = 0;
      }
      return morphs > 0;
    },
    /** Clears the count. Never throws. */
    reset(): void {
      morphs = 0;
    },
  };
}
