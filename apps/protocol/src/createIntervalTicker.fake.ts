// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A ticker the test ticks. */
export function createTestTicker() {
  const ticks = new Set<() => void>();
  let started = 0;

  return {
    /** Starts a ticker that runs on each `tick` until its stop runs. Never throws. */
    startTicker,
    /** Runs every ticker that is running. Throws what a ticker throws. */
    tick,
    /** How many times a ticker was started. Never throws. */
    countStarted: (): number => started,
    /** How many tickers are running. Never throws. */
    countRunning: (): number => ticks.size,
  };

  function startTicker(onTick: () => void): () => void {
    started += 1;
    // Its own entry, as a real interval is, so a ticker started again with the same callback is a second ticker.
    const ticker = (): void => {
      onTick();
    };
    ticks.add(ticker);
    return () => {
      ticks.delete(ticker);
    };
  }

  function tick(): void {
    for (const runTick of [...ticks]) {
      runTick();
    }
  }
}
