// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A root whose chunk loads on first use. Solid-free: the loaders that use it
// sit on startup paths and only import their chunk dynamically.

import { captureException } from "@dotli/metrics";

/** How long an idle prefetch waits for the browser to go idle. */
const PREFETCH_TIMEOUT_MS = 2000;

export interface LazyRoot {
  /** Load and mount the root once. Never rejects. */
  ensure: () => Promise<void>;
  /** Load and mount it when the browser is idle, before anything needs it. */
  prefetch: () => void;
  /** Tests only: forget the mounted root. */
  reset: () => void;
}

export interface LazyRootOptions {
  /**
   * Import the chunk and mount the root, passing it `onBroken` as mountRoot's
   * option of that name.
   */
  load: (onBroken: () => void) => Promise<unknown>;
  /** The Sentry `kind` of a chunk that failed to load or mount. */
  errorKind: string;
  /**
   * The fallback when the chunk failed to load or mount, or the root later
   * broke. The next ensure() then tries again.
   */
  onFailure: () => void;
}

export function createLazyRoot({
  load,
  errorKind,
  onFailure,
}: LazyRootOptions): LazyRoot {
  let loading: Promise<void> | null = null;
  const fail = (): void => {
    loading = null;
    onFailure();
  };
  const ensure = (): Promise<void> =>
    (loading ??= load(fail).then(
      () => undefined,
      (err: unknown) => {
        captureException(err, { kind: errorKind });
        fail();
      },
    ));
  return {
    ensure,
    prefetch: () => {
      const run = (): void => {
        void ensure();
      };
      if (typeof window.requestIdleCallback === "function") {
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
