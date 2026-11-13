// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenericError, Result } from '@parity/truapi';
import { err, ok } from 'neverthrow';

/**
 * Streams `initial`, then each value `start` pushes, to every iteration apart. `start` runs once per iteration and
 * returns its cleanup. An error item ends the stream after it, and the cleanup runs on that error or when the consumer
 * stops. Starting an iteration throws only what `start` throws.
 */
export function createResultStream<T>(
  initial: T[],
  start: (push: (value: T) => void, pushError: (error: GenericError) => void) => () => void,
): AsyncIterable<Result<T, GenericError>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Result<T, GenericError>> {
      const queue: Result<T, GenericError>[] = initial.map(value => ok(value));
      // An object, as a plain `let` would read as still false after `start` returns, though `start` can stop the stream.
      const state = { stopped: false };
      let cleanup: (() => void) | null = null;
      let resolve: ((result: IteratorResult<Result<T, GenericError>>) => void) | null = null;

      function complete(): IteratorResult<Result<T, GenericError>> {
        return { done: true, value: undefined };
      }

      function runCleanup(): void {
        const run = cleanup;
        cleanup = null;
        run?.();
      }

      function deliver(result: Result<T, GenericError>): void {
        if (resolve) {
          const send = resolve;
          resolve = null;
          send({ done: false, value: result });
          return;
        }
        queue.push(result);
      }

      function push(value: T): void {
        if (state.stopped) {
          return;
        }
        deliver(ok(value));
      }

      function pushError(error: GenericError): void {
        if (state.stopped) {
          return;
        }
        state.stopped = true;
        runCleanup();
        deliver(err(error));
      }

      cleanup = start(push, pushError);
      if (state.stopped) {
        runCleanup();
      }

      return {
        next(): Promise<IteratorResult<Result<T, GenericError>>> {
          const item = queue.shift();
          if (item) {
            return Promise.resolve({ done: false, value: item });
          }
          if (state.stopped) {
            return Promise.resolve(complete());
          }
          return new Promise(settle => {
            resolve = settle;
          });
        },
        return(): Promise<IteratorResult<Result<T, GenericError>>> {
          state.stopped = true;
          runCleanup();
          if (resolve) {
            const send = resolve;
            resolve = null;
            send(complete());
          }
          return Promise.resolve(complete());
        },
      };
    },
  };
}
