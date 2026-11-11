// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSharedRun } from './createSharedRun.js';
import { catchError } from './testing/catchError.js';

describe('createSharedRun', () => {
  it('As a second caller, I join a running run and my params are ignored', () => {
    // Given a run the first caller began
    const fake = createFakeBegin<string>();
    const run = createSharedRun<string>({ begin: fake.begin });
    run.join('first');

    // When
    run.join('second');

    // Then
    expect(fake.params).toEqual(['first']);
  });

  it('As one of two callers, I stop twice and the run keeps going until the other stops', () => {
    // Given a run two callers joined
    const fake = createFakeBegin();
    const run = createSharedRun({ begin: fake.begin });
    const stopMine = run.join();
    const stopOther = run.join();

    // When I stop twice, and then the other caller stops
    stopMine();
    stopMine();
    const endsAfterMine = fake.ends[0];
    stopOther();

    // Then
    expect(endsAfterMine).toBe(0);
    expect(fake.ends).toEqual([1]);
  });

  it('As a store reset, I end the run and the stops callers still hold do nothing', () => {
    // Given a run two callers joined
    const fake = createFakeBegin();
    const run = createSharedRun({ begin: fake.begin });
    const stopFirst = run.join();
    const stopSecond = run.join();

    // When the reset ends it, and then the callers stop
    run.end();
    const endsAfterReset = fake.ends[0];
    stopFirst();
    stopSecond();

    // Then
    expect(endsAfterReset).toBe(1);
    expect(fake.ends).toEqual([1]);
  });

  it('As a caller after an end, I join again and an old stop cannot end the new run', () => {
    // Given a run that ended through `end`, and a stop left over from it
    const fake = createFakeBegin();
    const run = createSharedRun({ begin: fake.begin });
    const staleStop = run.join();
    run.end();

    // When I join again, and the old stop is called
    run.join();
    staleStop();

    // Then
    expect(fake.params).toHaveLength(2);
    expect(fake.ends).toEqual([1, 0]);
  });

  it('As a caller whose begin throws, I get its error and the next join begins again', () => {
    // Given a begin that throws the first time only
    const broken = new Error('begin broke');
    let begins = 0;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        if (begins === 1) {
          throw broken;
        }
        return () => undefined;
      },
    });

    // When
    const failure = catchError(() => run.join());
    run.join();

    // Then
    expect(failure).toBe(broken);
    expect(begins).toBe(2);
  });

  it("As the last caller whose run's end throws, I get its error and the next join begins a new run", () => {
    // Given a run whose end throws
    const broken = new Error('end broke');
    const fake = createFakeBegin({ endError: broken });
    const run = createSharedRun({ begin: fake.begin });
    const stop = run.join();

    // When
    const failure = catchError(stop);
    run.join();

    // Then
    expect(failure).toBe(broken);
    expect(fake.params).toHaveLength(2);
  });

  it("As a store reset whose run's end throws, I get its error and the next join begins a new run", () => {
    // Given a run whose end throws
    const broken = new Error('end broke');
    const fake = createFakeBegin({ endError: broken });
    const run = createSharedRun({ begin: fake.begin });
    run.join();

    // When
    const failure = catchError(run.end);
    run.join();

    // Then
    expect(failure).toBe(broken);
    expect(fake.params).toHaveLength(2);
  });

  it('As a listener woken while the run begins, I join and share it, so it begins once and ends after both stops', () => {
    // Given a begin that joins the run it begins and keeps that nested stop
    let begins = 0;
    let ends = 0;
    let stopNested = (): void => undefined;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        if (begins === 1) {
          stopNested = run.join();
        }
        return () => {
          ends += 1;
        };
      },
    });

    // When the outer join returns, and then the outer stop and the nested stop are called in that order
    const stopOuter = run.join();
    stopOuter();
    const endsAfterOuterStop = ends;
    stopNested();

    // Then
    expect(begins).toBe(1);
    expect(endsAfterOuterStop).toBe(0);
    expect(ends).toBe(1);
  });

  it("As a store reset that ends the run while it begins, I end it once begin returns and the first caller's stop does nothing", () => {
    // Given a begin that ends the run it begins
    let begins = 0;
    let ends = 0;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        if (begins === 1) {
          run.end();
        }
        return () => {
          ends += 1;
        };
      },
    });

    // When the join returns, and then its stop is called
    const stop = run.join();
    const endsAfterJoin = ends;
    stop();

    // Then
    expect(endsAfterJoin).toBe(1);
    expect(ends).toBe(1);
  });

  it('As a caller after a run ended while it began, I join in a later turn and a new run begins', () => {
    // Given a run that was ended while it began
    const events: string[] = [];
    let begins = 0;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        events.push('begin');
        if (begins === 1) {
          run.end();
        }
        return () => {
          events.push('end');
        };
      },
    });
    run.join();

    // When
    run.join();

    // Then
    expect(events).toEqual(['begin', 'end', 'begin']);
  });

  it('As a listener woken after the run was ended while it began, I join and get an error', () => {
    // Given a begin that ends the run it begins and then joins it, keeping what that join throws
    let begins = 0;
    let ends = 0;
    let nestedFailure: unknown;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        if (begins === 1) {
          run.end();
          nestedFailure = catchError(() => run.join());
        }
        return () => {
          ends += 1;
        };
      },
    });

    // When
    run.join();

    // Then
    expect(nestedFailure).toBeInstanceOf(Error);
    expect(nestedFailure).toHaveProperty(
      'message',
      'createSharedRun: cannot join a run that was ended inside its own begin',
    );
    expect(ends).toBe(1);
  });

  it('As a listener woken while a begin that throws runs, I join and my stop does nothing, and the next join begins again', () => {
    // Given a begin that joins the run it begins, keeps that nested stop and throws, on its first call only
    const broken = new Error('begin broke');
    let begins = 0;
    let ends = 0;
    let stopNested = (): void => undefined;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        if (begins === 1) {
          stopNested = run.join();
          throw broken;
        }
        return () => {
          ends += 1;
        };
      },
    });

    // When the outer join throws, the nested stop is called, and a caller joins again
    const failure = catchError(() => run.join());
    stopNested();
    run.join();

    // Then
    expect(failure).toBe(broken);
    expect(begins).toBe(2);
    expect(ends).toBe(0);
  });

  it("As a store reset that ends the run while it begins, whose end throws, I see the first caller's join throw that error and the next join begin again", () => {
    // Given a begin that ends the run it begins on its first call, and returns an end that throws
    const broken = new Error('end broke');
    let begins = 0;
    const run = createSharedRun({
      begin: () => {
        begins += 1;
        if (begins === 1) {
          run.end();
        }
        return () => {
          throw broken;
        };
      },
    });

    // When
    const failure = catchError(() => run.join());
    run.join();

    // Then
    expect(failure).toBe(broken);
    expect(begins).toBe(2);
  });

  it('As a store reset with no run going, I end and nothing happens', () => {
    // Given a run nobody joined
    const fake = createFakeBegin();
    const run = createSharedRun({ begin: fake.begin });

    // When
    const failure = catchError(run.end);

    // Then
    expect(failure).toBeUndefined();
    expect(fake.ends).toEqual([]);
  });
});

/** A begin that records each run's params and counts each run's end calls, by run. */
function createFakeBegin<StartParams = void>({ endError }: { endError?: Error } = {}) {
  const params: StartParams[] = [];
  const ends: number[] = [];

  return { begin, params, ends };

  function begin(startParams: StartParams): () => void {
    const index = params.push(startParams) - 1;
    ends.push(0);
    return () => {
      ends[index] = (ends[index] ?? 0) + 1;
      if (endError !== undefined) {
        throw endError;
      }
    };
  }
}
