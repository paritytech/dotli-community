// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Queue for `notification.push` with `scheduledAt` and for each product's one game reminder, shared by the product's
// same-origin tabs. The host's scheduler coordinates which tab fires.

import { pageIdb, type DotliIdb } from './db.js';
import {
  NOTIFICATION_BY_PRODUCT_ID as BY_PRODUCT_ID,
  NOTIFICATION_BY_SCHEDULED_AT as BY_SCHEDULED_AT,
  NOTIFICATION_COUNTER_STORE as COUNTER_STORE,
  NOTIFICATION_STORE as RECORD_STORE,
} from './schema.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { runIdbTransaction, waitForIdbRequest } from '@dotli/shared';

/** Pending scheduled pushes per product before `schedule` returns ScheduleLimitReached. */
const SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP = 20;

type ScheduledPushRecord = {
  kind: 'push';
  hostId: number;
  perProductId: number;
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number;
};

/** The product's one game reminder, shown when its game starts at `scheduledAt`. */
type GameReminderRecord = {
  kind: 'gameReminder';
  hostId: number;
  productId: string;
  title: string;
  text: string;
  deeplink: null;
  scheduledAt: number;
};

export type ScheduledNotificationRecord = ScheduledPushRecord | GameReminderRecord;

/** How many ms past its `scheduledAt` a record of each kind is still shown, before `removeStale` drops it. */
const MAX_AGE_MS = {
  push: 24 * 60 * 60 * 1000,
  // A later reminder would announce a game already under way.
  gameReminder: 60 * 1000,
} satisfies Record<ScheduledNotificationRecord['kind'], number>;

export type ScheduleRequest = Omit<ScheduledPushRecord, 'kind' | 'hostId' | 'perProductId'>;

export type GameReminderRequest = Pick<GameReminderRecord, 'productId' | 'title' | 'text' | 'scheduledAt'>;

export type ScheduleResult = { ok: true; id: number } | { ok: false; error: 'ScheduleLimitReached' };

/** A record as stored, where one written before records had a kind is a push without it. */
type StoredRecord = ScheduledNotificationRecord | Omit<ScheduledPushRecord, 'kind'>;

type CounterEntry = {
  productId: string;
  next: number;
};

type Params = {
  /** The database the queue lives in. */
  idb?: DotliIdb;
};

/**
 * The scheduled notification queue over `idb`, the page's own by default. Every member rejects when the database
 * fails.
 */
export function createScheduledNotifications({ idb = pageIdb }: Params = {}) {
  // One transaction for cap check, counter bump and insert, so sibling tabs cannot duplicate ids or overshoot the cap.
  async function schedule(request: ScheduleRequest): Promise<ScheduleResult> {
    const db = await idb.connect();
    // An object, since the compiler cannot see the body assign the result before it is read after the transaction.
    const outcome: { result: ScheduleResult | null } = { result: null };
    await runIdbTransaction({
      db,
      stores: [RECORD_STORE, COUNTER_STORE],
      mode: 'readwrite',
      body: transaction => {
        const records = transaction.objectStore(RECORD_STORE);
        const counters = transaction.objectStore(COUNTER_STORE);
        const heldRequest = records.index(BY_PRODUCT_ID).getAll(idb.keyRange().only(request.productId));
        heldRequest.onsuccess = () => {
          const pushes = heldRequest.result.filter(value => readRecord(value).kind === 'push');
          // Nothing is written yet, so the transaction commits empty.
          if (pushes.length >= SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP) {
            outcome.result = { ok: false, error: 'ScheduleLimitReached' };
            return;
          }
          takeNextId(counters, request.productId, next => {
            const insertRequest = records.add({
              ...request,
              kind: 'push',
              perProductId: next,
            } satisfies Omit<ScheduledPushRecord, 'hostId'>);
            insertRequest.onsuccess = () => {
              outcome.result = { ok: true, id: next };
            };
          });
        };
      },
    });
    if (outcome.result === null) {
      throw new Error('schedule tx completed without a result');
    }
    return outcome.result;
  }

  // One transaction for the removal and the insert, so a sibling tab never sees the product hold two reminders.
  async function holdGameReminder(request: GameReminderRequest): Promise<void> {
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readwrite',
      body: transaction => {
        const records = transaction.objectStore(RECORD_STORE);
        removeGameReminder(records, idb.keyRange().only(request.productId), () => {
          records.add({
            ...request,
            kind: 'gameReminder',
            deeplink: null,
          } satisfies Omit<GameReminderRecord, 'hostId'>);
        });
      },
    });
  }

  async function cancelGameReminder(productId: string): Promise<void> {
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readwrite',
      body: transaction => {
        removeGameReminder(transaction.objectStore(RECORD_STORE), idb.keyRange().only(productId));
      },
    });
  }

  async function allocateId(productId: string): Promise<number> {
    const db = await idb.connect();
    let allocated = 0;
    await runIdbTransaction({
      db,
      stores: COUNTER_STORE,
      mode: 'readwrite',
      body: transaction => {
        takeNextId(transaction.objectStore(COUNTER_STORE), productId, next => {
          allocated = next;
        });
      },
    });
    return allocated;
  }

  async function cancel(productId: string, perProductId: number): Promise<boolean> {
    const db = await idb.connect();
    let deleted = false;
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readwrite',
      body: transaction => {
        const byProduct = transaction.objectStore(RECORD_STORE).index(BY_PRODUCT_ID);
        const cursorRequest = byProduct.openCursor(idb.keyRange().only(productId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          const record = readRecord(cursor.value);
          if (record.kind === 'push' && record.perProductId === perProductId) {
            cursor.delete();
            deleted = true;
            return;
          }
          cursor.continue();
        };
      },
    });
    return deleted;
  }

  async function removeById(hostId: number): Promise<boolean> {
    const db = await idb.connect();
    let existed = false;
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readwrite',
      body: transaction => {
        const records = transaction.objectStore(RECORD_STORE);
        const request = records.get(hostId);
        request.onsuccess = () => {
          if (request.result !== undefined) {
            records.delete(hostId);
            existed = true;
          }
        };
      },
    });
    return existed;
  }

  async function listAll(): Promise<ScheduledNotificationRecord[]> {
    const db = await idb.connect();
    const records = await waitForIdbRequest(
      db.transaction(RECORD_STORE, 'readonly').objectStore(RECORD_STORE).getAll(),
    );
    return records.map(record => readRecord(record));
  }

  async function removeStale(now: number): Promise<number> {
    const db = await idb.connect();
    let removed = 0;
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readwrite',
      body: transaction => {
        const byScheduledAt = transaction.objectStore(RECORD_STORE).index(BY_SCHEDULED_AT);
        const cursorRequest = byScheduledAt.openCursor(idb.keyRange().upperBound(now, true));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          const record = readRecord(cursor.value);
          if (now - record.scheduledAt > MAX_AGE_MS[record.kind]) {
            cursor.delete();
            removed += 1;
          }
          cursor.continue();
        };
      },
    });
    return removed;
  }

  return {
    /** Queues the push, or resolves `ScheduleLimitReached` when the product already has its cap of pushes pending. */
    schedule,
    /**
     * Holds the product's game reminder in place of the one it held. Its pushes and other products' stay. Rejects when
     * the database cannot be opened or the write fails.
     */
    holdGameReminder,
    /**
     * Drops the product's game reminder. Idempotent, so it resolves when none is held. Rejects when the database cannot
     * be opened or the write fails.
     */
    cancelGameReminder,
    /** Bump the counter without a record, so an immediate notification still gets a monotonic id. */
    allocateId,
    /** Idempotent. Resolves `false` when the push already fired or never existed. */
    cancel,
    /** Removes the record with `hostId`, resolving whether it was there. */
    removeById,
    /** Every queued notification, in host id order. */
    listAll,
    /**
     * Removes the records too far past their `scheduledAt` at `now`, a push after a day and a game reminder after a
     * minute, resolving how many.
     */
    removeStale,
  };
}

export type ScheduledNotifications = ReturnType<typeof createScheduledNotifications>;

/** The page's scheduled notification queue. */
export const scheduledNotifications = createScheduledNotifications();

function readRecord(value: unknown): ScheduledNotificationRecord {
  const stored = unsafe_readStoredRecord<StoredRecord>(value);
  if ('kind' in stored) {
    return stored;
  }
  return { ...stored, kind: 'push' };
}

/** Bumps the product's counter in `counters` and hands the new id to `then`, inside the caller's transaction. */
function takeNextId(counters: IDBObjectStore, productId: string, then: (next: number) => void): void {
  const request = counters.get(productId);
  request.onsuccess = () => {
    const current = unsafe_readStoredRecord<CounterEntry | undefined>(request.result);
    const next = (current?.next ?? 0) + 1;
    counters.put({ productId, next } satisfies CounterEntry);
    then(next);
  };
}

/**
 * Deletes the game reminder among the records in `product`, one product's key range, and calls `then` once every one
 * was visited, inside the caller's transaction.
 */
function removeGameReminder(records: IDBObjectStore, product: IDBKeyRange, then?: () => void): void {
  const cursorRequest = records.index(BY_PRODUCT_ID).openCursor(product);
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      then?.();
      return;
    }
    if (readRecord(cursor.value).kind === 'gameReminder') {
      cursor.delete();
    }
    cursor.continue();
  };
}
