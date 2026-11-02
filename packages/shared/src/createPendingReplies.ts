// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The table that pairs a request with the reply carrying its id, for any channel that answers out of band.

import { toError } from './toError.js';

type Wait<Value, Meta> = {
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
  meta: Meta | undefined;
};

type WaitParams<Meta> = {
  meta?: Meta;
};

export type PendingReplies<Id, Value, Meta = undefined> = ReturnType<typeof createPendingReplies<Id, Value, Meta>>;

/**
 * A table of waits keyed by request id. A settled id leaves the table, so a late reply finds nothing.
 *
 * @example
 * const replies = createPendingReplies<number, Uint8Array>();
 * const reply = replies.wait(id); // later, the message handler calls replies.resolve(id, bytes)
 */
export function createPendingReplies<Id, Value, Meta = undefined>() {
  const waits = new Map<Id, Wait<Value, Meta>>();

  return {
    /**
     * Waits for the reply to `id`. `meta` is what the reply handler reads back with `getMeta(id)`. Throws when a wait
     * on `id` is already open. Rejects with the error `reject` or `rejectAll` gives it.
     */
    wait(id: Id, { meta }: WaitParams<Meta> = {}): Promise<Value> {
      // A second wait would orphan the first, which then never settles.
      if (waits.has(id)) {
        throw new Error(`A reply to id ${String(id)} is already awaited`);
      }
      return new Promise<Value>((resolve, reject) => {
        waits.set(id, { resolve, reject, meta });
      });
    },
    /** What the wait on `id` carries, or `undefined` once nothing waits on it. */
    getMeta(id: Id): Meta | undefined {
      return waits.get(id)?.meta;
    },
    /** Settles the wait on `id`. False when nothing waits on it, such as for a late reply. */
    resolve(id: Id, value: Value): boolean {
      const wait = take(id);
      wait?.resolve(value);
      return wait !== undefined;
    },
    /** Fails the wait on `id`. False when nothing waits on it. */
    reject(id: Id, error: Error): boolean {
      const wait = take(id);
      wait?.reject(error);
      return wait !== undefined;
    },
    /** Fails every open wait, each with its own error, for a channel that will answer none of them. */
    rejectAll(errorFor: (id: Id) => Error): void {
      const open = [...waits];
      waits.clear();
      for (const [id, wait] of open) {
        // A factory that throws still fails its wait, so the waits after it are not left open.
        try {
          wait.reject(errorFor(id));
        } catch (error) {
          wait.reject(toError(error));
        }
      }
    },
    /** The ids still waiting, oldest first. */
    listIds(): Id[] {
      return [...waits.keys()];
    },
  };

  function take(id: Id): Wait<Value, Meta> | undefined {
    const wait = waits.get(id);
    waits.delete(id);
    return wait;
  }
}
