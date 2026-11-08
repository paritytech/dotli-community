// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params<StartParams> = {
  /**
   * Begins the run the first caller joins, and returns its end. Called again only after a run ended. It may join or end
   * the run it begins: a join shares that run, and an end takes effect once it returns.
   */
  begin: (params: StartParams) => () => void;
};

type Run = {
  /** How many joins have not stopped yet. */
  callers: number;
  phase: RunPhase;
};

/**
 * Where a run is: its `begin` still runs, it was ended while its `begin` ran, or it runs with the end `begin` returned,
 * which may throw.
 */
type RunPhase = { kind: 'beginning' } | { kind: 'ending' } | { kind: 'running'; end: () => void };

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
     * `begin` throws. The stop acts once and rethrows what the run's end throws. A join made while `begin` runs joins
     * that run, and throws when the run was ended during that same `begin`. When the run was ended while `begin` ran,
     * the join that began it runs the end once `begin` returns and rethrows what the end throws.
     */
    join,
    /**
     * Ends the run now, whatever stops callers still hold. Does nothing with no run going. Never throws unless the
     * run's end does. Called while `begin` runs, the run ends once `begin` returns.
     */
    end,
  };

  function join(params: StartParams): () => void {
    if (current === null) {
      return beginRun(params);
    }
    return joinRun(current);
  }

  function end(): void {
    if (current === null) {
      return;
    }
    endRun(current);
  }

  function beginRun(params: StartParams): () => void {
    const run: Run = { callers: 0, phase: { kind: 'beginning' } };
    // Current and counted before `begin`, so a join or an end from inside it acts on this run.
    current = run;
    const stop = joinRun(run);
    let runEnd: () => void;
    try {
      runEnd = begin(params);
    } catch (error) {
      if (current === run) {
        current = null;
      }
      throw error;
    }
    settleBegin(run, runEnd);
    return stop;
  }

  function joinRun(run: Run): () => void {
    switch (run.phase.kind) {
      case 'beginning':
      case 'running':
        return addCaller(run);
      case 'ending':
        throw new Error('createSharedRun: cannot join a run that was ended inside its own begin');
    }
  }

  function addCaller(run: Run): () => void {
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
        stopRun(run);
      }
    }
  }

  function endRun(run: Run): void {
    switch (run.phase.kind) {
      case 'beginning':
        run.phase = { kind: 'ending' };
        return;
      case 'ending':
        return;
      case 'running':
        finish(run.phase.end);
        return;
    }
  }

  function stopRun(run: Run): void {
    switch (run.phase.kind) {
      case 'running':
        finish(run.phase.end);
        return;
      // The join that began the run holds a caller until `begin` returns, so a last stop always meets a running run.
      case 'beginning':
      case 'ending':
        return;
    }
  }

  function settleBegin(run: Run, runEnd: () => void): void {
    switch (run.phase.kind) {
      case 'beginning':
        run.phase = { kind: 'running', end: runEnd };
        return;
      case 'ending':
        finish(runEnd);
        return;
      // Only this call's own `begin` makes a run running, so `begin` has not returned for it twice.
      case 'running':
        return;
    }
  }

  function finish(runEnd: () => void): void {
    // Cleared first, so an end that throws leaves no run behind.
    current = null;
    runEnd();
  }
}
