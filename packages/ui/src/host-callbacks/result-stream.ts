import type { GenericError, Result } from "@parity/truapi";
import { ok } from "neverthrow";

export function createResultStream<T>(
  initial: T[],
  start: (push: (value: T) => void) => () => void,
): AsyncIterable<Result<T, GenericError>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Result<T, GenericError>> {
      const queue = initial.map((value) => ({ value }));
      let stopped = false;
      let resolve:
        | ((result: IteratorResult<Result<T, GenericError>>) => void)
        | null = null;

      const complete = (): IteratorResult<Result<T, GenericError>> => ({
        done: true,
        value: undefined as never,
      });
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
        queue.push({ value });
      };
      const cleanup = start(push);

      return {
        next(): Promise<IteratorResult<Result<T, GenericError>>> {
          if (stopped) {
            return Promise.resolve(complete());
          }
          const item = queue.shift();
          if (item) {
            return Promise.resolve({ done: false, value: ok(item.value) });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
        return(): Promise<IteratorResult<Result<T, GenericError>>> {
          stopped = true;
          cleanup();
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
