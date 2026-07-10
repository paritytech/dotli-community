import type { GenericError, Result } from "@parity/truapi";
import { err, ok } from "neverthrow";

export function createResultStream<T>(
  initial: T[],
  start: (
    push: (value: T) => void,
    pushError: (error: GenericError) => void,
  ) => () => void,
): AsyncIterable<Result<T, GenericError>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Result<T, GenericError>> {
      const queue: Result<T, GenericError>[] = initial.map((value) =>
        ok(value),
      );
      let stopped = false;
      let cleanup: (() => void) | null = null;
      let cleanedUp = false;
      let resolve:
        | ((result: IteratorResult<Result<T, GenericError>>) => void)
        | null = null;

      const complete = (): IteratorResult<Result<T, GenericError>> => ({
        done: true,
        value: undefined as never,
      });
      const runCleanup = (): void => {
        if (cleanedUp || cleanup === null) {
          return;
        }
        cleanedUp = true;
        cleanup();
      };
      const push = (value: T): void => {
        if (stopped) {
          return;
        }
        if (resolve) {
          const send = resolve;
          resolve = null;
          send({ done: false, value: ok(value) });
          return;
        }
        queue.push(ok(value));
      };
      const pushError = (error: GenericError): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        runCleanup();
        const result = err<T, GenericError>(error);
        if (resolve) {
          const send = resolve;
          resolve = null;
          send({ done: false, value: result });
          return;
        }
        queue.push(result);
      };
      cleanup = start(push, pushError);
      if (stopped) {
        runCleanup();
      }

      return {
        next(): Promise<IteratorResult<Result<T, GenericError>>> {
          const item = queue.shift();
          if (item) {
            return Promise.resolve({ done: false, value: item });
          }
          if (stopped) {
            return Promise.resolve(complete());
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
        return(): Promise<IteratorResult<Result<T, GenericError>>> {
          stopped = true;
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
