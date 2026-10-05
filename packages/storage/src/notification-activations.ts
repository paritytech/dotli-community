// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Host-only notification ownership, shared by the page and its service worker. */
export interface NotificationScope {
  product: string;
  account: string;
  network: string;
  artifact: string;
}

export interface NotificationRecord {
  sequence: number;
  token: string;
  notificationId: number;
  scope: NotificationScope;
  entryUrl: string;
  route: string | null;
  expiresAt: number;
  activated: boolean;
  acknowledged: boolean;
}

const STORE = 'notifications';
const CAPACITY = 256;
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  // The host's ES2022 browser baseline does not provide Promise.withResolvers.
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dotli-notification-activations', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'sequence', autoIncrement: true });
      store.createIndex('token', 'token', { unique: true });
      store.createIndex('notification', ['scope.product', 'notificationId'], { unique: true });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error('Notification storage upgrade blocked'));
    };
  });
  return database;
}

export function sameNotificationScope(a: NotificationScope, b: NotificationScope): boolean {
  return a.product === b.product && a.account === b.account && a.network === b.network && a.artifact === b.artifact;
}

/** Relative routes are data for the product, never navigation authority. */
export function validNotificationRoute(route: string): boolean {
  if (!route.startsWith('/') || route.startsWith('//') || route.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(route))
    return false;
  try {
    const decoded = decodeURIComponent(route);
    return !decoded.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(decoded);
  } catch {
    return false;
  }
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error ?? new Error('Notification storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Notification storage aborted'));
    run(tx.objectStore(STORE), result => {
      value = result;
    });
  });
}

export async function retainNotification(
  input: Omit<NotificationRecord, 'sequence' | 'activated' | 'acknowledged' | 'token'>,
): Promise<NotificationRecord> {
  if (input.route !== null && !validNotificationRoute(input.route))
    throw new Error('Notification destination must be product-relative');
  const token = crypto.randomUUID();
  return transaction('readwrite', (store, result) => {
    const all = store.getAll();
    all.onsuccess = () => {
      const now = Date.now();
      const current = (all.result as NotificationRecord[]).filter(record => {
        if (record.expiresAt <= now || record.acknowledged) {
          store.delete(record.sequence);
          return false;
        }
        return true;
      });
      if (current.length >= CAPACITY) {
        // Keep clicked, unhandled events; retire the oldest unclicked notification.
        const oldestUnclicked = current.find(record => !record.activated);
        if (!oldestUnclicked) {
          store.transaction.abort();
          return;
        }
        store.delete(oldestUnclicked.sequence);
      }
      const record = { ...input, token, activated: false, acknowledged: false };
      const added = store.add(record);
      added.onsuccess = () => result({ ...record, sequence: added.result as number });
    };
  });
}

export async function findNotification(
  product: string,
  notificationId: number,
): Promise<NotificationRecord | undefined> {
  return transaction('readonly', (store, result) => {
    const request = store.index('notification').get([product, notificationId]);
    request.onsuccess = () => result(request.result as NotificationRecord | undefined);
  });
}

/** Repeated OS callbacks retain one event, including after acknowledgement. */
export async function activateNotification(token: string): Promise<NotificationRecord | undefined> {
  return transaction('readwrite', (store, result) => {
    const request = store.index('token').get(token);
    request.onsuccess = () => {
      const record = request.result as NotificationRecord | undefined;
      if (!record || record.expiresAt <= Date.now() || record.acknowledged) {
        result(undefined);
        return;
      }
      if (!record.activated) {
        record.activated = true;
        store.put(record);
      }
      result(record);
    };
  });
}

export async function pendingNotificationActivations(scope: NotificationScope): Promise<NotificationRecord[]> {
  return transaction('readonly', (store, result) => {
    const request = store.getAll();
    request.onsuccess = () =>
      result(
        (request.result as NotificationRecord[])
          .filter(
            record =>
              sameNotificationScope(record.scope, scope) &&
              record.activated &&
              !record.acknowledged &&
              record.route !== null &&
              record.expiresAt > Date.now(),
          )
          .slice(0, 32),
      );
  });
}

export async function acknowledgeNotificationActivation(scope: NotificationScope, sequence: number): Promise<void> {
  await transaction<void>('readwrite', (store, result) => {
    const request = store.get(sequence);
    request.onsuccess = () => {
      const record = request.result as NotificationRecord | undefined;
      if (record && record.activated && sameNotificationScope(record.scope, scope)) {
        record.acknowledged = true;
        store.put(record);
      }
      result(undefined);
    };
  });
}

export async function cancelNotificationActivation(product: string, notificationId: number): Promise<void> {
  await transaction<void>('readwrite', (store, result) => {
    const request = store.index('notification').get([product, notificationId]);
    request.onsuccess = () => {
      const record = request.result as NotificationRecord | undefined;
      if (record) store.delete(record.sequence);
      result(undefined);
    };
  });
}
