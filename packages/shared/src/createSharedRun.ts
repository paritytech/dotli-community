// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params<StartParams> = {
  /** Begins the run the first caller joins, and returns its end. Called again only after a run ended. */
  begin: (params: StartParams) => () => void;
};

type Run = {
  /** What `begin` returned. May throw. */
  end: () => void;
  /** How many joins have not stopped yet. */
  callers: number;
};

/**
 * One run shared by every caller of `join`. The first join begins it, each join gets its own stop that acts once, and
 * the run ends with the last stop or with `end`. A stop left over from an ended run does nothing.
 *
 * @example
 * const follow = createSharedRun<{ monitor: Monitor }>({ begin: ({ monitor }) => monitor.subscribe(sync) });
 * const stop = follow.join({ monitor });
 */
export function createSharedRun<StartParams = void>({ begin }: Params<StartParams>) {
  let current: Run | null = null;

  return {
    /**
     * Joins the run, beginning it with `params` when none is going, and returns this caller's stop. Rethrows what
     * `begin` throws. The stop acts once and rethrows what the run's end throws.
     */
    join,
    /**
     * Ends the run now, whatever stops callers still hold. Does nothing with no run going. Never throws unless the
     * run's end does.
     */
    end,
  };

  function join(params: StartParams): () => void {
    const run = current ?? { end: begin(params), callers: 0 };
    current = run;
    run.callers += 1;
    let stopped = false;
    return stop;

    function stop(): void {
      if (stopped || current !== run) {
        return;
      }
      stopped = true;
      run.callers -= 1;
      if (run.callers === 0) {
        finish(run);
      }
    }
  }

  function end(): void {
    if (current === null) {
      return;
    }
    finish(current);
  }

  function finish(run: Run): void {
    // Cleared first, so an end that throws leaves no run behind.
    current = null;
    run.end();
  }
}
