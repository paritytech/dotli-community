// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter } from '@dotli/metrics';

const releaseFailed = createReporter({ flow: 'ui' }).listener('product_frame.release');

/** Releases held together, which all go as the side ends. */
export type Side = ReturnType<typeof createSide>;

/**
 * Holds releases until the side ends. Ending it aborts `signal`, then runs its holds once, last in, first out, so what
 * was built on a resource goes before that resource. A hold on a side that already ended is released at once. A
 * release that throws is reported, so the releases after it still run.
 */
export function createSide() {
  const ending = new AbortController();
  const holds: (() => void)[] = [];
  return {
    /** Aborts as the side ends, for work that stops with it. */
    signal: ending.signal,
    /** Keeps `release` until the side ends. */
    hold(release: () => void): void {
      if (ending.signal.aborted) {
        runRelease(release);
        return;
      }
      holds.push(release);
    },
    /** Ends the side. Safe to call again. */
    end(): void {
      if (ending.signal.aborted) {
        return;
      }
      ending.abort();
      for (const release of holds.splice(0).reverse()) {
        runRelease(release);
      }
    },
  };
}

function runRelease(release: () => void): void {
  try {
    release();
  } catch (error) {
    releaseFailed(error);
  }
}
