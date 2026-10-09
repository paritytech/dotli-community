// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Queue for `notification.push` with `scheduledAt`, shared by the product's same-origin tabs.
// The scheduler in packages/ui coordinates which tab fires.

import { getDb } from './db.js';
import { SCHEDULED_NOTIFICATIONS_MAX_AGE_MS, SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP } from '@dotli/config';

const RECORD_STORE = 'scheduled_notifications';
const COUNTER_STORE = 'notification_counters';
const BY_PRODUCT_ID = 'byProductId';

export interface ScheduledNotificationRecord {
  hostId: number;
  perProductId: number;
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number;
}

export interface ScheduleRequest {
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number;
}

export type ScheduleResult = { ok: true; id: number } | { ok: false; error: 'ScheduleLimitReached' };

interface CounterEntry {
  productId: string;
  next: number;
}

/**
 * Rejects on error or abort unless `body` sets its own handlers.
 * Opening the transaction throws on a closing connection, and that throw must reject the returned promise.
 */
function inTransaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  name: string,
  body: (tx: IDBTransaction, resolve: (value: T) => void, reject: (err: unknown) => void) => void,
): Promise<T> {
  return getDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        tx.onerror = () => {
          reject(tx.error ?? new Error(`${name} tx errored`));
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error(`${name} tx aborted`));
        };
        body(tx, resolve, reject);
      }),
  );
}

/**
 * One transaction for cap check, counter bump and insert, so sibling tabs cannot duplicate ids or overshoot the cap.
 */
export function schedule(req: ScheduleRequest): Promise<ScheduleResult> {
  return inTransaction<ScheduleResult>(
    [RECORD_STORE, COUNTER_STORE],
    'readwrite',
    'schedule',
    (tx, resolve, reject) => {
      const records = tx.objectStore(RECORD_STORE);
      const counters = tx.objectStore(COUNTER_STORE);
      const byProduct = records.index(BY_PRODUCT_ID);

      let result: ScheduleResult | null = null;

      const countReq = byProduct.count(IDBKeyRange.only(req.productId));
      countReq.onsuccess = () => {
        if (countReq.result >= SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP) {
          result = { ok: false, error: 'ScheduleLimitReached' };
          tx.abort();
          return;
        }

        const counterReq = counters.get(req.productId);
        counterReq.onsuccess = () => {
          const current = counterReq.result as CounterEntry | undefined;
          const next = (current?.next ?? 0) + 1;
          counters.put({
            productId: req.productId,
            next,
          } satisfies CounterEntry);

          const insertReq = records.add({
            perProductId: next,
            productId: req.productId,
            title: req.title,
            text: req.text,
            deeplink: req.deeplink,
            scheduledAt: req.scheduledAt,
          });
          insertReq.onsuccess = () => {
            result = { ok: true, id: next };
          };
        };
      };

      tx.oncomplete = () => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error('schedule tx completed without a result'));
        }
      };
      tx.onerror = () => {
        // The limit path aborts on purpose.
        if (result?.ok === false) {
          resolve(result);
        } else {
          reject(tx.error ?? new Error('schedule tx errored'));
        }
      };
      tx.onabort = () => {
        if (result?.ok === false) {
          resolve(result);
        } else {
          reject(tx.error ?? new Error('schedule tx aborted'));
        }
      };
    },
  );
}

/** Bump the counter without a record, so an immediate notification still gets a monotonic id. */
export function allocateId(productId: string): Promise<number> {
  return inTransaction<number>(COUNTER_STORE, 'readwrite', 'allocateId', (tx, resolve) => {
    const counters = tx.objectStore(COUNTER_STORE);
    let allocated = 0;

    const get = counters.get(productId);
    get.onsuccess = () => {
      const current = get.result as CounterEntry | undefined;
      allocated = (current?.next ?? 0) + 1;
      counters.put({ productId, next: allocated } satisfies CounterEntry);
    };

    tx.oncomplete = () => {
      resolve(allocated);
    };
  });
}

/** Idempotent. Resolves `false` when the notification already fired or never existed. */
export function cancel(productId: string, perProductId: number): Promise<boolean> {
  return inTransaction<boolean>(RECORD_STORE, 'readwrite', 'cancel', (tx, resolve) => {
    const byProduct = tx.objectStore(RECORD_STORE).index(BY_PRODUCT_ID);
    let deleted = false;

    const cursorReq = byProduct.openCursor(IDBKeyRange.only(productId));
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

    tx.oncomplete = () => {
      resolve(deleted);
    };
  });
}

export function removeById(hostId: number): Promise<boolean> {
  return inTransaction<boolean>(RECORD_STORE, 'readwrite', 'removeById', (tx, resolve) => {
    const records = tx.objectStore(RECORD_STORE);
    let existed = false;

    const getReq = records.get(hostId);
    getReq.onsuccess = () => {
      if (getReq.result !== undefined) {
        records.delete(hostId);
        existed = true;
      }
    };

    tx.oncomplete = () => {
      resolve(existed);
    };
  });
}

function collect(
  name: string,
  open: (store: IDBObjectStore) => IDBRequest<IDBCursorWithValue | null>,
): Promise<ScheduledNotificationRecord[]> {
  return inTransaction<ScheduledNotificationRecord[]>(RECORD_STORE, 'readonly', name, (tx, resolve) => {
    const out: ScheduledNotificationRecord[] = [];

    const cursorReq = open(tx.objectStore(RECORD_STORE));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        return;
      }
      out.push(cursor.value as ScheduledNotificationRecord);
      cursor.continue();
    };

    tx.oncomplete = () => {
      resolve(out);
    };
  });
}

export function listAll(): Promise<ScheduledNotificationRecord[]> {
  return collect('listAll', store => store.openCursor());
}

export function removeStale(now: number, maxAgeMs: number = SCHEDULED_NOTIFICATIONS_MAX_AGE_MS): Promise<number> {
  const cutoff = now - maxAgeMs;
  return inTransaction<number>(RECORD_STORE, 'readwrite', 'removeStale', (tx, resolve) => {
    const idx = tx.objectStore(RECORD_STORE).index('byScheduledAt');
    let removed = 0;

    const cursorReq = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        return;
      }
      cursor.delete();
      removed += 1;
      cursor.continue();
    };

    tx.oncomplete = () => {
      resolve(removed);
    };
  });
}
