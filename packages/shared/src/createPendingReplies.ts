// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The table that pairs a request with the reply carrying its id, for any channel that answers out of band.

import { createDeferred } from './createDeferred.js';

export type PendingReplies<Id, Value> = ReturnType<typeof createPendingReplies<Id, Value>>;

/**
 * A table of waits keyed by request id. A settled id leaves the table, so a late reply finds nothing.
 *
 * @example
 * const replies = createPendingReplies<number, Uint8Array>();
 * const reply = replies.wait(id); // later, the message handler calls replies.resolve(id, bytes)
 */
export function createPendingReplies<Id, Value>() {
  // Only the waits still open.
  const waits = new Map<Id, ReturnType<typeof createDeferred<Value>>>();

  return {
    /**
     * Waits for the reply to `id`. Rejects at once when a wait on `id` is already open, and leaves that wait open.
     * Otherwise rejects with the error `reject` or `rejectAll` gives it. Never throws.
     */
    wait(id: Id): Promise<Value> {
      // A second wait would orphan the first, which then never settles.
      if (waits.has(id)) {
        return Promise.reject(new Error(`A reply to id ${String(id)} is already awaited`));
      }
      const reply = createDeferred<Value>();
      waits.set(id, reply);
      return reply.promise;
    },
    /** Settles the wait on `id`. Does nothing when nothing waits on `id`, such as for a late reply. Never throws. */
    resolve(id: Id, value: Value): void {
      const reply = waits.get(id);
      waits.delete(id);
      reply?.resolve(value);
    },
    /** Fails the wait on `id`. Does nothing when nothing waits on `id`, such as for a late reply. Never throws. */
    reject(id: Id, error: Error): void {
      const reply = waits.get(id);
      waits.delete(id);
      reply?.reject(error);
    },
    /** Fails every open wait with `error`, for a channel that will answer none of them. Never throws. */
    rejectAll(error: Error): void {
      const open = [...waits.values()];
      waits.clear();
      for (const reply of open) {
        reply.reject(error);
      }
    },
    /** The ids still waiting, oldest first. Never throws. */
    listIds(): Id[] {
      return [...waits.keys()];
    },
  };
}
