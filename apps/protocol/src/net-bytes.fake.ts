// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Ticker } from './net-bytes.js';

export interface TestTicker {
  ticker: Ticker;
  /** Runs every ticker that is running. */
  tick: () => void;
  /** How many times a ticker was started. */
  started: () => number;
  /** How many tickers are running. */
  running: () => number;
}

/** A ticker the test ticks. */
export function createTestTicker(): TestTicker {
  const ticks = new Set<() => void>();
  let started = 0;
  return {
    ticker: onTick => {
      started += 1;
      ticks.add(onTick);
      return () => {
        ticks.delete(onTick);
      };
    },
    tick: () => {
      for (const tick of [...ticks]) {
        tick();
      }
    },
    started: () => started,
    running: () => ticks.size,
  };
}
