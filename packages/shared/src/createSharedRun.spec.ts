// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSharedRun } from './createSharedRun.js';
import { catchError } from './testing/catchError.js';

describe('createSharedRun', () => {
  it('As a first caller, I join the run and it begins once with my params', () => {
    // Given
    const fake = createFakeBegin<string>();
    const run = createSharedRun<string>({ begin: fake.begin });

    // When
    run.join('first');

    // Then
    expect(fake.params).toEqual(['first']);
  });

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

  it('As a caller whose run ended with my last stop, I stop again after a new run began and it keeps going', () => {
    // Given a run that ended with my stop, and a new run another caller began
    const fake = createFakeBegin();
    const run = createSharedRun({ begin: fake.begin });
    const stopMine = run.join();
    stopMine();
    run.join();

    // When
    stopMine();

    // Then
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
