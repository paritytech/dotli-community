// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter } from '@dotli/metrics';
import { noop } from '@dotli/shared';

const releaseFailed = createReporter({ flow: 'ui' }).listener('product_frame.release');

/** Releases held together, which all go as the side ends. */
export type Side = ReturnType<typeof createSide>;

/**
 * Holds releases until the side ends. Ending it runs its holds once, last in, first out, so what was built on a
 * resource goes before that resource. A hold on a side that already ended is released at once. A release that throws
 * is reported, so the releases after it still run.
 */
export function createSide() {
  let ended = false;
  const holds = new Set<() => void>();
  return {
    /**
     * Keeps `release` until the side ends. Returns a release that runs it before then and lets go of it. Each release
     * runs at most once, however often the returned one is called.
     */
    hold(release: () => void): () => void {
      if (ended) {
        runRelease(release);
        return noop;
      }
      holds.add(release);
      return () => {
        if (holds.delete(release)) {
          runRelease(release);
        }
      };
    },
    /** Ends the side. Safe to call again. */
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      const releases = [...holds].reverse();
      holds.clear();
      for (const release of releases) {
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
