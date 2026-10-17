// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox speaks within seconds of starting. A frame whose origin the browser blocks, or whose page never runs,
// says nothing, and without a deadline the loading screen would wait for it for good.

import { realTimers, withTimeout, type Timers } from '@dotli/shared';

/** How long the sandbox has to speak once it was handed the content. */
const SANDBOX_SILENCE_MS = 30_000;

/** The sandbox frame said nothing within its deadline. */
export class SandboxSilentError extends Error {
  constructor(ms: number) {
    super(`The app frame sent nothing within ${String(ms / 1000)}s`);
    this.name = 'SandboxSilentError';
  }
}

export interface SandboxWatch {
  /** Settles once the sandbox has spoken, or rejects with `SandboxSilentError` when it stays silent for `ms` from now. */
  expectWithin: (ms?: number) => Promise<void>;
}

/**
 * Listens from the call, so a sandbox that speaks before the deadline starts still counts. `onHeard` hears each message
 * the sandbox sends about its load and returns its unsubscribe.
 */
export function watchSandbox(onHeard: (listener: () => void) => () => void, timers: Timers = realTimers): SandboxWatch {
  let stop: () => void = () => undefined;
  const heard = new Promise<void>(resolve => {
    stop = onHeard(() => {
      resolve();
    });
  });
  // After the subscribe has returned, since the sandbox may already have spoken during it.
  void heard.then(() => {
    stop();
  });
  return {
    expectWithin: (ms = SANDBOX_SILENCE_MS) =>
      withTimeout(heard, ms, () => new SandboxSilentError(ms), timers).catch((error: unknown) => {
        stop();
        throw error;
      }),
  };
}
