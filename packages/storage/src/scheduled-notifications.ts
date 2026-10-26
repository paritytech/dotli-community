// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Queue for `notification.push` with `scheduledAt`, shared by the product's same-origin tabs.
// The host's scheduler coordinates which tab fires.

import { pageIdb, type DotliIdb } from './db.js';
import { idbTransaction } from '@dotli/shared';

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

/** The scheduled notification queue over `idb`, the page's own by default. */
export function createScheduledNotifications(idb: DotliIdb = pageIdb) {
  /**
   * One transaction for cap check, counter bump and insert, so sibling tabs cannot duplicate ids or overshoot the cap.
   */
  async function schedule(req: ScheduleRequest): Promise<ScheduleResult> {
    const db = await idb.connect();
    // An object, since the compiler cannot see the body assign the result before it is read after the transaction.
    const outcome: { result: ScheduleResult | null } = { result: null };
    try {
      await idbTransaction(db, [RECORD_STORE, COUNTER_STORE], 'readwrite', tx => {
        const records = tx.objectStore(RECORD_STORE);
        const counters = tx.objectStore(COUNTER_STORE);
        const countReq = records.index(BY_PRODUCT_ID).count(idb.keyRange().only(req.productId));
        countReq.onsuccess = () => {
          if (countReq.result >= SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP) {
            outcome.result = { ok: false, error: 'ScheduleLimitReached' };
            tx.abort();
            return;
          }
          const counterReq = counters.get(req.productId);
          counterReq.onsuccess = () => {
            const current = counterReq.result as CounterEntry | undefined;
            const next = (current?.next ?? 0) + 1;
            counters.put({ productId: req.productId, next } satisfies CounterEntry);
            const insertReq = records.add({
              perProductId: next,
              productId: req.productId,
              title: req.title,
              text: req.text,
              deeplink: req.deeplink,
              scheduledAt: req.scheduledAt,
            });
            insertReq.onsuccess = () => {
              outcome.result = { ok: true, id: next };
            };
          };
        };
      });
    } catch (err: unknown) {
      // The cap aborts the transaction on purpose.
      if (outcome.result?.ok === false) {
        return outcome.result;
      }
      throw err;
    }
    if (outcome.result === null) {
      throw new Error('schedule tx completed without a result');
    }
    return outcome.result;
  }

  /** Bump the counter without a record, so an immediate notification still gets a monotonic id. */
  async function allocateId(productId: string): Promise<number> {
    const db = await idb.connect();
    let allocated = 0;
    await idbTransaction(db, COUNTER_STORE, 'readwrite', tx => {
      const counters = tx.objectStore(COUNTER_STORE);
      const get = counters.get(productId);
      get.onsuccess = () => {
        const current = get.result as CounterEntry | undefined;
        allocated = (current?.next ?? 0) + 1;
        counters.put({ productId, next: allocated } satisfies CounterEntry);
      };
    });
    return allocated;
  }

  /** Idempotent. Resolves `false` when the notification already fired or never existed. */
  async function cancel(productId: string, perProductId: number): Promise<boolean> {
    const db = await idb.connect();
    let deleted = false;
    await idbTransaction(db, RECORD_STORE, 'readwrite', tx => {
      const byProduct = tx.objectStore(RECORD_STORE).index(BY_PRODUCT_ID);
      const cursorReq = byProduct.openCursor(idb.keyRange().only(productId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          return;
        }
        const rec = cursor.value as ScheduledNotificationRecord;
        if (rec.perProductId === perProductId) {
          cursor.delete();
          deleted = true;
          return;
        }
        cursor.continue();
      };
    });
    return deleted;
  }

  async function removeById(hostId: number): Promise<boolean> {
    const db = await idb.connect();
    let existed = false;
    await idbTransaction(db, RECORD_STORE, 'readwrite', tx => {
      const records = tx.objectStore(RECORD_STORE);
      const getReq = records.get(hostId);
      getReq.onsuccess = () => {
        if (getReq.result !== undefined) {
          records.delete(hostId);
          existed = true;
        }
      };
    });
    return existed;
  }

  async function collect(
    open: (store: IDBObjectStore) => IDBRequest<IDBCursorWithValue | null>,
  ): Promise<ScheduledNotificationRecord[]> {
    const db = await idb.connect();
    const out: ScheduledNotificationRecord[] = [];
    await idbTransaction(db, RECORD_STORE, 'readonly', tx => {
      const cursorReq = open(tx.objectStore(RECORD_STORE));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          return;
        }
        out.push(cursor.value as ScheduledNotificationRecord);
        cursor.continue();
      };
    });
    return out;
  }

  function listAll(): Promise<ScheduledNotificationRecord[]> {
    return collect(store => store.openCursor());
  }

  async function removeStale(now: number, maxAgeMs: number = SCHEDULED_NOTIFICATIONS_MAX_AGE_MS): Promise<number> {
    const cutoff = now - maxAgeMs;
    const db = await idb.connect();
    let removed = 0;
    await idbTransaction(db, RECORD_STORE, 'readwrite', tx => {
      const idx = tx.objectStore(RECORD_STORE).index('byScheduledAt');
      const cursorReq = idx.openCursor(idb.keyRange().upperBound(cutoff, true));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          return;
        }
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
    });
    return removed;
  }

  return { schedule, allocateId, cancel, removeById, listAll, removeStale };
}

export type ScheduledNotifications = ReturnType<typeof createScheduledNotifications>;

export const { schedule, allocateId, cancel, removeById, listAll, removeStale }: ScheduledNotifications =
  createScheduledNotifications();
