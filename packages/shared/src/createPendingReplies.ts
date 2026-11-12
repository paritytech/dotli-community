// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The table that pairs a request with the reply carrying its id, for any channel that answers out of band.

import { createStateMachine, nest, type MachineTypes } from './createStateMachine.js';
import { rejectUnhandled } from './rejectUnhandled.js';
import { toError } from './toError.js';

type Waiting<Value, Meta> = {
  kind: 'waiting';
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
  meta: Meta | undefined;
};

type Wait<Value, Meta> = Waiting<Value, Meta> | { kind: 'settled' };

/** A settled wait leaves the table, so `waits` holds only the waits still open. */
type RepliesState<Id, Value, Meta> = { kind: 'open'; waits: ReadonlyMap<Id, Waiting<Value, Meta>> };

type RepliesEvent<Id, Value, Meta> =
  | { kind: 'waited'; id: Id; wait: Waiting<Value, Meta> }
  | { kind: 'replied'; id: Id; value: Value }
  | { kind: 'failed'; id: Id; error: Error }
  | { kind: 'allFailed'; errorFor: (id: Id) => Error };

type RepliesMachine<Id, Value, Meta> = MachineTypes<RepliesState<Id, Value, Meta>, RepliesEvent<Id, Value, Meta>>;

type WaitMachine<Id, Value, Meta> = MachineTypes<Wait<Value, Meta>, RepliesEvent<Id, Value, Meta>>;

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
  const handleWait = nest<RepliesMachine<Id, Value, Meta>, 'open', WaitMachine<Id, Value, Meta>, 'replied' | 'failed'>({
    find: ({ waits }, { id }) => waits.get(id) ?? null,
    store(state, { id }, next) {
      const waits = new Map(state.waits);
      switch (next.kind) {
        case 'waiting':
          waits.set(id, next);
          break;
        case 'settled':
          waits.delete(id);
          break;
      }
      return { ...state, waits };
    },
    handlers: {
      waiting: {
        replied({ resolve }, { value }, { emitState }) {
          emitState({ kind: 'settled' });
          resolve(value);
        },
        failed({ reject }, { error }, { emitState }) {
          emitState({ kind: 'settled' });
          reject(error);
        },
      },
      settled: null,
    },
  });
  const machine = createStateMachine<RepliesMachine<Id, Value, Meta>>({
    initial: { kind: 'open', waits: new Map() },
    handlers: {
      open: {
        waited(state, { id, wait }, { emitState }) {
          // A second wait on an id can arrive queued behind the first, such as when an error factory waits twice.
          if (state.waits.has(id)) {
            wait.reject(createAwaitedError(id));
            return;
          }
          emitState({ ...state, waits: new Map(state.waits).set(id, wait) });
        },
        replied: handleWait,
        failed: handleWait,
        allFailed(state, { errorFor }, { emitState }) {
          emitState({ ...state, waits: new Map() });
          for (const [id, { reject }] of state.waits) {
            // A factory that throws still fails its wait, so the waits after it are not left open.
            try {
              reject(errorFor(id));
            } catch (error) {
              reject(toError(error));
            }
          }
        },
      },
    },
    onError: rejectUnhandled,
  });

  return {
    /**
     * Waits for the reply to `id`. `meta` is what the reply handler reads back with `getMeta(id)`. Throws when a wait
     * on `id` is already open, except inside a `rejectAll` error factory, where the second wait rejects with the
     * already-awaited error instead of throwing. Otherwise rejects with the error `reject` or `rejectAll` gives it.
     */
    wait(id: Id, { meta }: WaitParams<Meta> = {}): Promise<Value> {
      // A second wait would orphan the first, which then never settles.
      if (machine.state.get().waits.has(id)) {
        throw createAwaitedError(id);
      }
      return new Promise<Value>((resolve, reject) => {
        machine.update({ kind: 'waited', id, wait: { kind: 'waiting', resolve, reject, meta } });
      });
    },
    /** What the wait on `id` carries, or `undefined` once nothing waits on it. Never throws. */
    getMeta(id: Id): Meta | undefined {
      return machine.state.get().waits.get(id)?.meta;
    },
    /** Settles the wait on `id`. Does nothing when nothing waits on `id`, such as for a late reply. Never throws. */
    resolve(id: Id, value: Value): void {
      machine.update({ kind: 'replied', id, value });
    },
    /** Fails the wait on `id`. Does nothing when nothing waits on `id`, such as for a late reply. Never throws. */
    reject(id: Id, error: Error): void {
      machine.update({ kind: 'failed', id, error });
    },
    /** Fails every open wait, each with its own error, for a channel that will answer none of them. Never throws. */
    rejectAll(errorFor: (id: Id) => Error): void {
      machine.update({ kind: 'allFailed', errorFor });
    },
    /** The ids still waiting, oldest first. Never throws. */
    listIds(): Id[] {
      return [...machine.state.get().waits.keys()];
    },
  };
}

function createAwaitedError(id: unknown): Error {
  return new Error(`A reply to id ${String(id)} is already awaited`);
}
