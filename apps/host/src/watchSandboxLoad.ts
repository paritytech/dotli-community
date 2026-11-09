// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one owner of what the sandbox said about the page's load: that it spoke, that it cleared the loading screen and
// how its load ended. The sandbox speaks within seconds of starting. A frame whose origin the browser blocks, or whose
// page never runs, says nothing, and without a deadline the load would wait for it for good.

import { isLoadedOutcome, type SandboxChannel, type SandboxLoadOutcome } from '@dotli/sandbox-wire';
import { createReporter } from '@dotli/metrics';
import { createDeferred, createListenerSet, realTimers, withTimeout, type Timers } from '@dotli/shared';

/** What the sandbox reported about how its load ended, its failed step cleaned for a tag. */
export type SandboxLoadReport = { outcome: SandboxLoadOutcome; failedStep: string | undefined };

export type SandboxLoad = ReturnType<typeof watchSandboxLoad>;

type Params = {
  /** The deadline's clock, the real one by default. */
  timers?: Timers | undefined;
};

/** How long the sandbox has to speak once it was handed the content. */
const SANDBOX_SILENCE_MS = 30_000;

// Becomes a Sentry tag from another origin, so anything but a short snake_case token is dropped.
const FAILED_STEP_RE = /^[a-z][a-z0-9_]{0,39}$/;

const report = createReporter({ flow: 'content' });

/**
 * Returns the page's watch on the sandbox's load. It listens from the call until `dispose`, so a sandbox that
 * speaks before the deadline starts still counts, and a load that ends again, such as a retry, is heard too. Throws only
 * as `channel.on` does.
 */
export function watchSandboxLoad(channel: Pick<SandboxChannel, 'on'>, { timers = realTimers }: Params = {}) {
  const heard = createDeferred<undefined>();
  const cleared = createDeferred<undefined>();
  const outcome = createDeferred<SandboxLoadReport>();
  const outcomes = createListenerSet<SandboxLoadReport>({ onListenerError: report.listener('sandbox_load.outcome') });
  let latest: SandboxLoadReport | null = null;
  // Dropped at the first stop, so a later one finds nothing to undo.
  let stopListening: (() => void) | undefined = channel.on(
    'dotli:loading-status',
    ({ done, outcome: ended, failedStep }) => {
      heard.resolve(undefined);
      // A `done` without an outcome only clears the screen for a prompt the sandbox shows before its content loads.
      if (done !== true) {
        return;
      }
      cleared.resolve(undefined);
      if (ended !== undefined) {
        const ending: SandboxLoadReport = {
          outcome: ended,
          failedStep: isLoadedOutcome(ended) ? undefined : toTagStep(failedStep),
        };
        latest = ending;
        outcome.resolve(ending);
        outcomes.emit(ending);
      }
    },
  );

  return {
    /** Settles at the sandbox's first message about its load. Never rejects. */
    heard: heard.promise,
    /** Settles at its first `done`, with or without an outcome. Never rejects. */
    cleared: cleared.promise,
    /** Settles with its first outcome. Never rejects. */
    outcome: outcome.promise,
    /**
     * The listener hears the latest outcome at once when one came, then every later one in order. A listener that
     * throws is reported and does not stop the others. The returned unsubscribe is safe to call more than once. Never
     * throws.
     */
    subscribeOutcomes,
    /** Settles once heard, or rejects with `SandboxSilentError` when unheard for `silenceMs` from the call. */
    expectHeardWithin: (silenceMs = SANDBOX_SILENCE_MS): Promise<void> =>
      withTimeout({
        work: heard.promise,
        ms: silenceMs,
        timeoutError: () => new SandboxSilentError(silenceMs),
        timers,
      }),
    /**
     * Stops listening, so a later message settles and delivers nothing, and leaves each promise as it stands. Safe to
     * call again.
     * Throws only as the unsubscribe `channel.on` returned does.
     */
    dispose,
  };

  function subscribeOutcomes(listener: (report: SandboxLoadReport) => void): () => void {
    if (latest !== null) {
      outcomes.deliver(listener, latest);
    }
    return outcomes.subscribe(listener);
  }

  function dispose(): void {
    const stop = stopListening;
    stopListening = undefined;
    stop?.();
  }
}

/** The sandbox frame said nothing within its deadline. */
export class SandboxSilentError extends Error {
  constructor(silenceMs: number) {
    super(`The app frame sent nothing within ${String(silenceMs / 1000)}s`);
    this.name = 'SandboxSilentError';
  }
}

function toTagStep(step: string | undefined): string | undefined {
  return step !== undefined && FAILED_STEP_RE.test(step) ? step : undefined;
}
