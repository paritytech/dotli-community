// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The table that pairs a request with the reply carrying its id, for any channel that answers out of band.

export interface PendingReplies<Id, Value, Meta = undefined> {
  /** Waits for the reply to `id`. `meta` is what the reply handler reads back with `meta(id)`. */
  wait(id: Id, meta?: Meta): Promise<Value>;
  /** What the wait on `id` carries, or `undefined` once nothing waits on it. */
  meta(id: Id): Meta | undefined;
  /** Settles the wait on `id`. False when nothing waits on it, such as for a late reply. */
  resolve(id: Id, value: Value): boolean;
  /** Fails the wait on `id`. False when nothing waits on it. */
  reject(id: Id, error: Error): boolean;
  /** Fails every open wait, each with its own error, for a channel that will answer none of them. */
  rejectAll(errorFor: (id: Id) => Error): void;
  /** The ids still waiting, oldest first. */
  ids(): Id[];
}

interface Wait<Value, Meta> {
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
  meta: Meta | undefined;
}

/** A table of waits keyed by request id. A settled id leaves the table, so a late reply finds nothing. */
export function createPendingReplies<Id, Value, Meta = undefined>(): PendingReplies<Id, Value, Meta> {
  const waits = new Map<Id, Wait<Value, Meta>>();
  const take = (id: Id): Wait<Value, Meta> | undefined => {
    const wait = waits.get(id);
    waits.delete(id);
    return wait;
  };
  return {
    wait(id, meta) {
      // A second wait would orphan the first, which then never settles.
      if (waits.has(id)) {
        throw new Error('A reply to this id is already awaited');
      }
      return new Promise<Value>((resolve, reject) => {
        waits.set(id, { resolve, reject, meta });
      });
    },
    meta: id => waits.get(id)?.meta,
    resolve(id, value) {
      const wait = take(id);
      wait?.resolve(value);
      return wait !== undefined;
    },
    reject(id, error) {
      const wait = take(id);
      wait?.reject(error);
      return wait !== undefined;
    },
    rejectAll(errorFor) {
      const open = [...waits];
      waits.clear();
      for (const [id, wait] of open) {
        wait.reject(errorFor(id));
      }
    },
    ids: () => [...waits.keys()],
  };
}
