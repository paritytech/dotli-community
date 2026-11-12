// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The table that pairs a request with the reply carrying its id, for any channel that answers out of band.

import { createDeferred } from './createDeferred.js';
import { createStateMachine, type MachineTypes } from './createStateMachine.js';
import { rejectUnhandled } from './rejectUnhandled.js';

type Reply<Value> = ReturnType<typeof createDeferred<Value>>;

type Wait<Value, Meta> = { reply: Reply<Value>; meta: Meta | undefined };

/** A settled wait leaves the table, so `waits` holds only the waits still open. */
type RepliesState<Id, Value, Meta> = { kind: 'open'; waits: ReadonlyMap<Id, Wait<Value, Meta>> };

type RepliesEvent<Id, Value, Meta> =
  | { kind: 'waited'; id: Id; wait: Wait<Value, Meta> }
  | { kind: 'replied'; id: Id; value: Value }
  | { kind: 'failed'; id: Id; error: Error }
  | { kind: 'allFailed'; error: Error };

type RepliesEffect<Value> =
  { kind: 'resolve'; reply: Reply<Value>; value: Value } | { kind: 'reject'; reply: Reply<Value>; error: Error };

type RepliesMachine<Id, Value, Meta> = MachineTypes<
  RepliesState<Id, Value, Meta>,
  RepliesEvent<Id, Value, Meta>,
  RepliesEffect<Value>
>;

export type PendingReplies<Id, Value, Meta = undefined> = ReturnType<typeof createPendingReplies<Id, Value, Meta>>;

/**
 * A table of waits keyed by request id. A settled id leaves the table, so a late reply finds nothing.
 *
 * @example
 * const replies = createPendingReplies<number, Uint8Array>();
 * const reply = replies.wait(id); // later, the message handler calls replies.resolve(id, bytes)
 */
export function createPendingReplies<Id, Value, Meta = undefined>() {
  const machine = createStateMachine<RepliesMachine<Id, Value, Meta>>({
    initial: { kind: 'open', waits: new Map() },
    handlers: {
      open: {
        waited(state, { id, wait }, { emitState }) {
          emitState({ ...state, waits: new Map(state.waits).set(id, wait) });
        },
        replied(state, { id, value }, { emitState, emitSideEffect }) {
          const wait = state.waits.get(id);
          if (wait === undefined) {
            return;
          }
          emitState({ ...state, waits: withoutId(state.waits, id) });
          emitSideEffect({ kind: 'resolve', reply: wait.reply, value });
        },
        failed(state, { id, error }, { emitState, emitSideEffect }) {
          const wait = state.waits.get(id);
          if (wait === undefined) {
            return;
          }
          emitState({ ...state, waits: withoutId(state.waits, id) });
          emitSideEffect({ kind: 'reject', reply: wait.reply, error });
        },
        allFailed(state, { error }, { emitState, emitSideEffect }) {
          emitState({ ...state, waits: new Map() });
          for (const { reply } of state.waits.values()) {
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
     * Waits for the reply to `id`. `meta` is what the reply handler reads back with `getMeta(id)`. Throws when a wait
     * on `id` is already open. Otherwise rejects with the error `reject` or `rejectAll` gives it.
     */
    wait(id: Id, { meta }: { meta?: Meta } = {}): Promise<Value> {
      // A second wait would orphan the first, which then never settles.
      if (machine.state.get().waits.has(id)) {
        throw new Error(`A reply to id ${String(id)} is already awaited`);
      }
      const reply = createDeferred<Value>();
      machine.update({ kind: 'waited', id, wait: { reply, meta } });
      return reply.promise;
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

function withoutId<Id, Wait>(waits: ReadonlyMap<Id, Wait>, id: Id): ReadonlyMap<Id, Wait> {
  const next = new Map(waits);
  next.delete(id);
  return next;
}
