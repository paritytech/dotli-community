// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toAbortError } from './toAbortError.js';

/** How the work a race started ends it. A call after the race has ended does nothing. */
export type Settle<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type Params<T> = AbortRejection & {
  signal?: AbortSignal | undefined;
  /** Begins the work, which ends the race through `settle`, and returns the cleanup of what it holds, such as a timer. */
  start: (settle: Settle<T>) => () => void;
};

/** What an abort rejects with: an AbortError with `abortMessage`, or what `toRejection` makes of the abort reason. */
type AbortRejection =
  | { abortMessage: string; toRejection?: undefined }
  | { toRejection: (reason: unknown) => Error; abortMessage?: undefined };

/**
 * The outcome of the work `start` begins, or the abort's rejection as soon as `signal` aborts. An already aborted
 * `signal` rejects at once and starts nothing. A `start` that throws makes the race reject with what it threw. The
 * cleanup runs and the abort listener goes before the caller hears the outcome, whichever way the race ends.
 */
export function raceAbort<T>({ signal, start, ...rejection }: Params<T>): Promise<T> {
  const toRejection = getToRejection(rejection);
  if (signal?.aborted === true) {
    return Promise.reject(toRejection(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    let ended = false;
    let cleanup: (() => void) | undefined;
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      cleanup = start({
        resolve: value => {
          if (end()) {
            resolve(value);
          }
        },
        reject: fail,
      });
    } catch (error) {
      fail(error);
    }
    // Work that ended the race inside `start` did so before its cleanup existed.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `start` may end the race, which narrowing cannot see
    if (ended) {
      cleanup?.();
    }

    function fail(error: unknown): void {
      if (end()) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the work's rejection passes on as it was thrown
        reject(error);
      }
    }

    function onAbort(): void {
      if (end()) {
        reject(toRejection(signal?.reason));
      }
    }

    /** Whether this call ended the race, releasing what it held. */
    function end(): boolean {
      if (ended) {
        return false;
      }
      ended = true;
      signal?.removeEventListener('abort', onAbort);
      cleanup?.();
      return true;
    }
  });
}

function getToRejection(rejection: AbortRejection): (reason: unknown) => Error {
  if (rejection.toRejection !== undefined) {
    return rejection.toRejection;
  }
  const { abortMessage } = rejection;
  return reason => toAbortError(reason, abortMessage);
}
