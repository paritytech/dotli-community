// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The table that pairs a request with the reply carrying its id, for any channel that answers out of band.

import { createDeferred } from './createDeferred.js';
import { createStateMachine, type MachineTypes } from './createStateMachine.js';
import { rejectUnhandled } from './rejectUnhandled.js';

type Reply<Value> = ReturnType<typeof createDeferred<Value>>;

/** A settled wait leaves the table, so `waits` holds only the waits still open. */
type RepliesState<Id, Value> = { kind: 'open'; waits: ReadonlyMap<Id, Reply<Value>> };

type RepliesEvent<Id, Value> =
  | { kind: 'waited'; id: Id; reply: Reply<Value> }
  | { kind: 'replied'; id: Id; value: Value }
  | { kind: 'failed'; id: Id; error: Error }
  | { kind: 'allFailed'; error: Error };

type RepliesEffect<Value> =
  { kind: 'resolve'; reply: Reply<Value>; value: Value } | { kind: 'reject'; reply: Reply<Value>; error: Error };

type RepliesMachine<Id, Value> = MachineTypes<RepliesState<Id, Value>, RepliesEvent<Id, Value>, RepliesEffect<Value>>;

export type PendingReplies<Id, Value> = ReturnType<typeof createPendingReplies<Id, Value>>;

/**
 * A table of waits keyed by request id. A settled id leaves the table, so a late reply finds nothing.
 *
 * @example
 * const replies = createPendingReplies<number, Uint8Array>();
 * const reply = replies.wait(id); // later, the message handler calls replies.resolve(id, bytes)
 */
export function createPendingReplies<Id, Value>() {
  const machine = createStateMachine<RepliesMachine<Id, Value>>({
    initial: { kind: 'open', waits: new Map() },
    handlers: {
      open: {
        waited(state, { id, reply }, { emitState, emitSideEffect }) {
          // A second wait would orphan the first, which then never settles.
          if (state.waits.has(id)) {
            emitSideEffect({
              kind: 'reject',
              reply,
              error: new Error(`A reply to id ${String(id)} is already awaited`),
            });
            return;
          }
          emitState({ ...state, waits: new Map(state.waits).set(id, reply) });
        },
        replied(state, { id, value }, { emitState, emitSideEffect }) {
          const reply = state.waits.get(id);
          if (reply === undefined) {
            return;
          }
          emitState({ ...state, waits: withoutId(state.waits, id) });
          emitSideEffect({ kind: 'resolve', reply, value });
        },
        failed(state, { id, error }, { emitState, emitSideEffect }) {
          const reply = state.waits.get(id);
          if (reply === undefined) {
            return;
          }
          emitState({ ...state, waits: withoutId(state.waits, id) });
          emitSideEffect({ kind: 'reject', reply, error });
        },
        allFailed(state, { error }, { emitState, emitSideEffect }) {
          emitState({ ...state, waits: new Map() });
          for (const reply of state.waits.values()) {
            emitSideEffect({ kind: 'reject', reply, error });
          }
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'resolve':
          effect.reply.resolve(effect.value);
          return;
        case 'reject':
          effect.reply.reject(effect.error);
          return;
      }
    },
    onError: rejectUnhandled,
  });

  return {
    /**
     * Waits for the reply to `id`. Rejects at once when a wait on `id` is already open, and leaves that wait open.
     * Otherwise rejects with the error `reject` or `rejectAll` gives it. Never throws.
     */
    wait(id: Id): Promise<Value> {
      const reply = createDeferred<Value>();
      machine.update({ kind: 'waited', id, reply });
      return reply.promise;
    },
    /** Settles the wait on `id`. Does nothing when nothing waits on `id`, such as for a late reply. Never throws. */
    resolve(id: Id, value: Value): void {
      machine.update({ kind: 'replied', id, value });
    },
    /** Fails the wait on `id`. Does nothing when nothing waits on `id`, such as for a late reply. Never throws. */
    reject(id: Id, error: Error): void {
      machine.update({ kind: 'failed', id, error });
    },
    /** Fails every open wait with `error`, for a channel that will answer none of them. Never throws. */
    rejectAll(error: Error): void {
      machine.update({ kind: 'allFailed', error });
    },
    /** The ids still waiting, oldest first. Never throws. */
    listIds(): Id[] {
      return [...machine.state.get().waits.keys()];
    },
  };
}

function withoutId<Id, Reply>(waits: ReadonlyMap<Id, Reply>, id: Id): ReadonlyMap<Id, Reply> {
  const next = new Map(waits);
  next.delete(id);
  return next;
}
