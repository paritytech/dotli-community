// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Queue for `notification.push` with `scheduledAt`, shared by the product's same-origin tabs.
// The host's scheduler coordinates which tab fires.

import { pageIdb, type DotliIdb } from './db.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { runIdbTransaction } from '@dotli/shared';

/** Drop scheduled notifications older than this many ms past `scheduledAt`. */
const SCHEDULED_NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Pending scheduled notifications per product before `schedule` returns ScheduleLimitReached. */
const SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP = 20;

const RECORD_STORE = 'scheduled_notifications';
const COUNTER_STORE = 'notification_counters';
const BY_PRODUCT_ID = 'byProductId';

export type ScheduledNotificationRecord = {
  hostId: number;
  perProductId: number;
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number;
};

export type ScheduleRequest = {
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number;
};

export type ScheduleResult = { ok: true; id: number } | { ok: false; error: 'ScheduleLimitReached' };

type CounterEntry = {
  productId: string;
  next: number;
};

type Params = {
  /** The database the queue lives in. */
  idb?: DotliIdb;
};

type RemoveStaleParams = {
  /** How long past its `scheduledAt` a notification is kept. */
  maxAgeMs?: number;
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
    try {
      await runIdbTransaction({
        db,
        stores: [RECORD_STORE, COUNTER_STORE],
        mode: 'readwrite',
        body: transaction => {
          const records = transaction.objectStore(RECORD_STORE);
          const counters = transaction.objectStore(COUNTER_STORE);
          const countRequest = records.index(BY_PRODUCT_ID).count(idb.keyRange().only(request.productId));
          countRequest.onsuccess = () => {
            if (countRequest.result >= SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP) {
              outcome.result = { ok: false, error: 'ScheduleLimitReached' };
              transaction.abort();
              return;
            }
            const counterRequest = counters.get(request.productId);
            counterRequest.onsuccess = () => {
              const current = unsafe_readStoredRecord<CounterEntry | undefined>(counterRequest.result);
              const next = (current?.next ?? 0) + 1;
              counters.put({ productId: request.productId, next } satisfies CounterEntry);
              const insertRequest = records.add({
                perProductId: next,
                productId: request.productId,
                title: request.title,
                text: request.text,
                deeplink: request.deeplink,
                scheduledAt: request.scheduledAt,
              });
              insertRequest.onsuccess = () => {
                outcome.result = { ok: true, id: next };
              };
            };
          };
        },
      });
    } catch (error: unknown) {
      // The cap aborts the transaction on purpose.
      if (outcome.result?.ok === false) {
        return outcome.result;
      }
      throw error;
    }
    if (outcome.result === null) {
      throw new Error('schedule tx completed without a result');
    }
    return outcome.result;
  }

  async function allocateId(productId: string): Promise<number> {
    const db = await idb.connect();
    let allocated = 0;
    await runIdbTransaction({
      db,
      stores: COUNTER_STORE,
      mode: 'readwrite',
      body: transaction => {
        const counters = transaction.objectStore(COUNTER_STORE);
        const request = counters.get(productId);
        request.onsuccess = () => {
          const current = unsafe_readStoredRecord<CounterEntry | undefined>(request.result);
          allocated = (current?.next ?? 0) + 1;
          counters.put({ productId, next: allocated } satisfies CounterEntry);
        };
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
          const record = unsafe_readStoredRecord<ScheduledNotificationRecord>(cursor.value);
          if (record.perProductId === perProductId) {
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

  async function collect(
    open: (store: IDBObjectStore) => IDBRequest<IDBCursorWithValue | null>,
  ): Promise<ScheduledNotificationRecord[]> {
    const db = await idb.connect();
    const out: ScheduledNotificationRecord[] = [];
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readonly',
      body: transaction => {
        const cursorRequest = open(transaction.objectStore(RECORD_STORE));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          out.push(unsafe_readStoredRecord<ScheduledNotificationRecord>(cursor.value));
          cursor.continue();
        };
      },
    });
    return out;
  }

  function listAll(): Promise<ScheduledNotificationRecord[]> {
    return collect(store => store.openCursor());
  }

  async function removeStale(
    now: number,
    { maxAgeMs = SCHEDULED_NOTIFICATIONS_MAX_AGE_MS }: RemoveStaleParams = {},
  ): Promise<number> {
    const cutoff = now - maxAgeMs;
    const db = await idb.connect();
    let removed = 0;
    await runIdbTransaction({
      db,
      stores: RECORD_STORE,
      mode: 'readwrite',
      body: transaction => {
        const byScheduledAt = transaction.objectStore(RECORD_STORE).index('byScheduledAt');
        const cursorRequest = byScheduledAt.openCursor(idb.keyRange().upperBound(cutoff, true));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
      },
    });
    return removed;
  }

  return {
    /** Queues the notification, or resolves `ScheduleLimitReached` when the product already has its cap pending. */
    schedule,
    /** Bump the counter without a record, so an immediate notification still gets a monotonic id. */
    allocateId,
    /** Idempotent. Resolves `false` when the notification already fired or never existed. */
    cancel,
    /** Removes the record with `hostId`, resolving whether it was there. */
    removeById,
    /** Every queued notification, in host id order. */
    listAll,
    /** Removes the notifications more than `maxAgeMs` past their `scheduledAt` at `now`, resolving how many. */
    removeStale,
  };
}

export type ScheduledNotifications = ReturnType<typeof createScheduledNotifications>;

/** The page's scheduled notification queue. */
export const scheduledNotifications = createScheduledNotifications();
