// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { createDeferred, createStateMachine, type MachineTypes } from '@dotli/shared';

const report = createReporter({ flow: 'storage' });
const dbConnectionTransitionMetric = defineCount<'error'>('db_connection.transition');

type Params = {
  /** Opens the database, and rejects when it cannot. */
  open: () => Promise<IDBDatabase>;
};

type Read = ReturnType<typeof createDeferred<IDBDatabase>>;

/** `asker` is the read whose ask started the open, so its failure goes to that read only. */
type DbState =
  { kind: 'closed' } | { kind: 'opening'; asker: Read; queued: readonly Read[] } | { kind: 'open'; db: IDBDatabase };

type DbEvent =
  | { kind: 'asked'; read: Read }
  | { kind: 'opened'; db: IDBDatabase }
  | { kind: 'openFailed'; error: unknown }
  | { kind: 'connectionClosed'; db: IDBDatabase }
  | { kind: 'upgradeAsked'; db: IDBDatabase };

type DbEffect =
  | { kind: 'close'; db: IDBDatabase }
  | { kind: 'resolve'; reads: readonly Read[]; db: IDBDatabase }
  | { kind: 'reject'; read: Read; error: unknown };

type DbMachine = MachineTypes<DbState, DbEvent, DbEffect>;

/**
 * One connection shared by every read, opened by `open` on first use. A connection that closes, or that another tab's
 * upgrade asks to close, is dropped, and a failed open is not retried: the next read opens again, which is when it can
 * succeed. A read rejects with the error of the open it started.
 */
export function createDbConnection({ open }: Params): () => Promise<IDBDatabase> {
  const machine = createStateMachine<DbMachine>({
    initial: { kind: 'closed' },
    handlers: {
      closed: {
        asked(_state, { read }, { emitState, update }) {
          emitState({ kind: 'opening', asker: read, queued: [] });
          update(runOpen());
        },
      },
      opening: {
        asked(state, { read }, { emitState }) {
          emitState({ ...state, queued: [...state.queued, read] });
        },
        opened({ asker, queued }, { db }, { emitState, emitSideEffect, update }) {
          db.onclose = () => {
            update({ kind: 'connectionClosed', db });
          };
          db.onversionchange = () => {
            update({ kind: 'upgradeAsked', db });
          };
          emitState({ kind: 'open', db });
          emitSideEffect({ kind: 'resolve', reads: [asker, ...queued], db });
        },
        openFailed({ asker, queued }, { error }, { emitState, emitSideEffect, update }) {
          emitSideEffect({ kind: 'reject', read: asker, error });
          const [next, ...rest] = queued;
          if (next === undefined) {
            emitState({ kind: 'closed' });
            return;
          }
          emitState({ kind: 'opening', asker: next, queued: rest });
          update(runOpen());
        },
      },
      open: {
        asked({ db }, { read }, { emitSideEffect }) {
          emitSideEffect({ kind: 'resolve', reads: [read], db });
        },
        // Only the open handle's own close drops it, so a late close of a replaced one keeps the newer.
        connectionClosed(state, { db }, { emitState }) {
          if (db !== state.db) {
            return;
          }
          emitState({ kind: 'closed' });
        },
        upgradeAsked(state, { db }, { emitState, emitSideEffect }) {
          if (db !== state.db) {
            return;
          }
          emitState({ kind: 'closed' });
          emitSideEffect({ kind: 'close', db });
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'close':
          effect.db.close();
          return;
        case 'resolve':
          for (const read of effect.reads) {
            read.resolve(effect.db);
          }
          return;
        case 'reject':
          effect.read.reject(effect.error);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: dbConnectionTransitionMetric,
        message: '[dot.li] A database connection transition threw',
      });
    },
  });

  return () => {
    const read = createDeferred<IDBDatabase>();
    machine.update({ kind: 'asked', read });
    return read.promise;
  };

  async function runOpen(): Promise<DbEvent> {
    try {
      return { kind: 'opened', db: await open() };
    } catch (error) {
      return { kind: 'openFailed', error };
    }
  }
}
