// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Solid-free because the loaders that use it sit on startup paths and only import their chunk dynamically.

import { captureException } from '@dotli/metrics';

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
}

export function createLazyRoot({ load, root, onFailure }: LazyRootOptions): LazyRoot {
  let loading: Promise<void> | null = null;
  const fail = (): void => {
    loading = null;
    onFailure();
  };
  const ensure = (): Promise<void> =>
    (loading ??= load(fail).then(
      () => undefined,
      (err: unknown) => {
        captureException(err, { flow: 'ui', step: 'root_load', tags: { root, kind: `${root}_load_error` } });
        fail();
      },
    ));
  return {
    ensure,
    prefetch: () => {
      const run = (): void => {
        void ensure();
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: PREFETCH_TIMEOUT_MS });
      } else {
        setTimeout(run, PREFETCH_TIMEOUT_MS);
      }
    },
    reset: () => {
      loading = null;
    },
  };
}
