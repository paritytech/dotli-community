// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persistent IDB queue for `notification.push` with `scheduledAt`.
 *
 * Lives on the product origin, shared across same-origin tabs of the same
 * product. Fire-time coordination across those tabs happens in the
 * scheduler runtime (packages/ui) via Web Locks and a BroadcastChannel.
 *
 * Two stores are touched in a single tx on schedule. The
 * `scheduled_notifications` store (keyPath hostId, autoIncrement) holds
 * the records. The `notification_counters` store (keyPath productId)
 * holds the monotonic per-product `next` value, so each schedule returns
 * a stable, unique `perProductId` for TrUAPI notification callbacks.
 */

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
 * Run `body` on a new transaction over `stores`, settling with what it
 * resolves. The transaction rejects on error or abort unless `body` sets its
 * own handlers.
 *
 * Opening the transaction can throw (a connection that is closing). That
 * throw must reject the returned promise: inside a `getDb().then` callback
 * whose promise is dropped, it left the caller pending forever and surfaced
 * as an unhandled rejection instead.
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
 * Atomically: enforce per-product cap, bump per-product counter, insert
 * record. All three operations run inside one readwrite tx so concurrent
 * schedules from sibling tabs cannot allocate duplicate ids or exceed the
 * cap.
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

          // hostId is autoIncrement, so it is omitted from the record.
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
        // The ScheduleLimitReached path aborts on purpose, so surface the
        // result rather than the abort error.
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

/**
 * Bump the per-product counter without persisting a record. Used by the
 * immediate-fire path so the returned NotificationId is still monotonic.
 */
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

/**
 * Idempotent. Returns true if a matching record was deleted, false if no
 * such (productId, perProductId) pair existed (already fired or never
 * scheduled).
 */
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

export function listForProduct(productId: string): Promise<ScheduledNotificationRecord[]> {
  return collect('listForProduct', store => store.index(BY_PRODUCT_ID).openCursor(IDBKeyRange.only(productId)));
}

/**
 * Delete every record whose `scheduledAt` is older than `now - maxAgeMs`.
 * Returns the number of records removed.
 */
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
