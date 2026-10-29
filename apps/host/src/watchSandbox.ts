// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox speaks within seconds of starting. A frame whose origin the browser blocks, or whose page never runs,
// says nothing, and without a deadline the loading screen would wait for it for good.

import { createDeferred, realTimers, withTimeout, type Timers } from '@dotli/shared';

type Params = {
  /** The deadline's clock, the real one by default. */
  timers?: Timers | undefined;
};

/** How long the sandbox has to speak once it was handed the content. */
const SANDBOX_SILENCE_MS = 30_000;

/**
 * Returns a watch that listens from the call, so a sandbox that speaks before the deadline starts still counts.
 * `onHeard` hears each message the sandbox sends about its load and returns its unsubscribe. Throws only as `onHeard`
 * does.
 */
export function watchSandbox(onHeard: (listener: () => void) => () => void, { timers = realTimers }: Params = {}) {
  const heard = createDeferred<undefined>();
  const dispose = onHeard(() => {
    heard.resolve(undefined);
  });
  // After the subscribe has returned, since the sandbox may already have spoken during it.
  void heard.promise.then(() => {
    dispose();
  });
  return {
    /**
     * Settles once the sandbox has spoken, or rejects with `SandboxSilentError` when it stays silent for `silenceMs`
     * from now.
     */
    expectWithin: (silenceMs = SANDBOX_SILENCE_MS): Promise<void> =>
      withTimeout({
        work: heard.promise,
        ms: silenceMs,
        timeoutError: () => new SandboxSilentError(silenceMs),
        timers,
      }).catch((error: unknown) => {
        dispose();
        throw error;
      }),
    /** Stops listening, for a load that ended before it set the deadline. Throws only as the unsubscribe does. */
    dispose,
  };
}

/** The sandbox frame said nothing within its deadline. */
export class SandboxSilentError extends Error {
  constructor(silenceMs: number) {
    super(`The app frame sent nothing within ${String(silenceMs / 1000)}s`);
    this.name = 'SandboxSilentError';
  }
}
