// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool } from '@dotli/shared';
import { runWhenIdle, type IdleScheduler } from '../idle.js';
import type { ReportFailure } from '../report.js';

const PREFETCH_TIMEOUT_MS = 2000;

export interface LazyRoot {
  /** Never rejects. */
  ensure: () => Promise<void>;
  prefetch: () => void;
  /** Tests only: forget the mounted root. */
  reset: () => void;
}

export interface LazyRootOptions {
  /** Passes `onBroken` on as mountRoot's option of that name. */
  load: (onBroken: () => void) => Promise<unknown>;
  root: string;
  /** Runs when the chunk fails to load or mount, or the root later breaks. The next ensure() retries. */
  onFailure: () => void;
  /** Takes a chunk that failed to load or mount. */
  report: ReportFailure;
  /** Where prefetch finds the browser's idle callbacks. The page's own by default. */
  idle?: IdleScheduler | undefined;
}

export function createLazyRoot({ load, root, onFailure, report, idle = globalThis }: LazyRootOptions): LazyRoot {
  // One mount at a time, so a call made while the root mounts waits for it and finds the root there.
  const mounts = createAsyncTaskPool({ poolSize: 1 });
  // Set as the mount starts, so a break reported while it runs is not undone when it resolves.
  let mounted = false;
  const fail = (): void => {
    mounted = false;
    onFailure();
  };
  const ensure = (): Promise<void> =>
    mounts.call(async () => {
      if (mounted) {
        return;
      }
      mounted = true;
      try {
        await load(fail);
      } catch (err: unknown) {
        report(err, { flow: 'ui', step: 'root_load', tags: { root, kind: `${root}_load_error` } });
        fail();
      }
    });
  return {
    ensure,
    prefetch: () => {
      runWhenIdle(
        () => {
          void ensure();
        },
        PREFETCH_TIMEOUT_MS,
        idle,
      );
    },
    reset: () => {
      mounted = false;
    },
  };
}
