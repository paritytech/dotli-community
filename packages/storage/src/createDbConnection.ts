// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type HandlerOf, type MachineTypes } from '@dotli/shared';

const report = createReporter({ flow: 'storage' });
const dbConnectionTransitionMetric = defineCount<'error'>('db_connection.transition');

type Params = {
  /** Opens the database, and rejects when it cannot. */
  open: () => Promise<IDBDatabase>;
};

/** `asker` is the token of the read whose ask started the open, so its failure goes to that read only. */
type DbState =
  | { kind: 'closed' }
  | { kind: 'opening'; asker: symbol }
  | { kind: 'open'; db: IDBDatabase }
  | { kind: 'failed'; asker: symbol; error: unknown };

type OpenState = Extract<DbState, { kind: 'open' }>;

type DbEvent =
  | { kind: 'asked'; asker: symbol }
  | { kind: 'opened'; db: IDBDatabase }
  | { kind: 'openFailed'; error: unknown }
  | { kind: 'dropped'; open: OpenState };

type DbMachine = MachineTypes<DbState, DbEvent>;

/**
 * One connection shared by every read, opened by `open` on first use. A connection that closes, or that another tab's
 * upgrade asks to close, is dropped, and a failed open is not retried: the next read opens again, which is when it can
 * succeed. A read rejects with the error of the open it started.
 */
export function createDbConnection({ open }: Params): () => Promise<IDBDatabase> {
  const startOpen: HandlerOf<DbMachine, 'closed' | 'failed', 'asked'> = (_state, { asker }, { emitState, update }) => {
    emitState({ kind: 'opening', asker });
    update(
      // An `open` that throws before it returns a promise rejects this one, so its error reaches the asker too.
      new Promise<IDBDatabase>(resolve => {
        resolve(open());
      }).then(
        db => ({ kind: 'opened', db }),
        (error: unknown) => ({ kind: 'openFailed', error }),
      ),
    );
  };
  const machine = createStateMachine<DbMachine>({
    initial: { kind: 'closed' },
    handlers: {
      closed: { asked: startOpen },
      // An `asked` here is ignored: that read waits for the open in flight.
      opening: {
        opened(_state, { db }, { emitState, update }) {
          const opened: OpenState = { kind: 'open', db };
          db.onclose = () => {
            update({ kind: 'dropped', open: opened });
          };
          db.onversionchange = () => {
            db.close();
            update({ kind: 'dropped', open: opened });
          };
          emitState(opened);
        },
        openFailed({ asker }, { error }, { emitState }) {
          emitState({ kind: 'failed', asker, error });
        },
      },
      open: {
        dropped(state, { open: dropped }, { emitState }) {
          // Only this handle's own close drops it, so a late close of a replaced one keeps the newer.
          if (dropped !== state) {
            return;
          }
          emitState({ kind: 'closed' });
        },
      },
      failed: { asked: startOpen },
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: dbConnectionTransitionMetric,
        message: '[dot.li] A database connection transition threw',
      });
    },
  });

  return getDb;

  async function getDb(): Promise<IDBDatabase> {
    const asker = Symbol('asker');
    // Reads wake in the order they called `await()`. A read that woke after another one's failure, or after another
    // read started the next open, asks again and waits on that open.
    for (;;) {
      machine.update({ kind: 'asked', asker });
      await machine.await();
      const settled = machine.state.get();
      switch (settled.kind) {
        case 'open':
          return settled.db;
        case 'failed':
          if (settled.asker === asker) {
            throw settled.error;
          }
          continue;
        case 'closed':
        case 'opening':
          continue;
      }
    }
  }
}
