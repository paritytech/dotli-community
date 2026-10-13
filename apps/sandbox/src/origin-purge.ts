// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { m, recordExpected, spans as S } from '@dotli/metrics';

/** The stores a product may leave in the sandbox origin. A store this browser lacks is `null`. */
export interface OriginStores {
  indexedDB: Pick<IDBFactory, 'databases' | 'deleteDatabase'> | null;
  caches: Pick<CacheStorage, 'keys' | 'delete'> | null;
  serviceWorker: Pick<ServiceWorkerContainer, 'getRegistrations'> | null;
  /** Read on use, since a browser that blocks storage throws on the read. */
  localStorage: () => Pick<Storage, 'clear'>;
  sessionStorage: () => Pick<Storage, 'clear'>;
  document: Pick<Document, 'cookie'>;
  /** The page's path, since a product may have set a cookie on it. */
  pathname: string;
}

function deleteDatabase(idb: Pick<IDBFactory, 'deleteDatabase'>, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = idb.deleteDatabase(name);
    req.onsuccess = (): void => {
      resolve();
    };
    req.onerror = (): void => {
      reject(req.error ?? new Error(`Could not delete database ${name}`));
    };
    req.onblocked = (): void => {
      reject(new Error(`Deleting database ${name} is blocked by an open connection`));
    };
  });
}

/**
 * Best-effort, since a page cannot reach `HttpOnly` cookies or, in older Firefox and Safari, enumerate IndexedDB. The
 * reset is opt-in, so a partial wipe is not fatal, and each store is wiped whatever happened to the one before.
 */
export async function purgeSandboxOriginState(stores: OriginStores): Promise<void> {
  const failed: string[] = [];
  const wipe = async (store: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (err) {
      // The browser refusing a store is not a bug, but it explains a product that still sees its old state.
      recordExpected(err, { flow: 'content', step: 'origin_purge' });
      failed.push(store);
    }
  };

  const { indexedDB: idb, caches, serviceWorker, document: page } = stores;
  if (idb !== null && typeof idb.databases === 'function') {
    await wipe('indexeddb', async () => {
      const dbs = await idb.databases();
      await Promise.all(
        dbs.flatMap(db => (db.name === undefined || db.name === '' ? [] : [deleteDatabase(idb, db.name)])),
      );
    });
  }
  if (caches !== null) {
    await wipe('caches', async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    });
  }
  if (serviceWorker !== null) {
    await wipe('service_worker', async () => {
      const registrations = await serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    });
  }
  await wipe('local_storage', () => {
    stores.localStorage().clear();
  });
  await wipe('session_storage', () => {
    stores.sessionStorage().clear();
  });
  // A product may have set a cookie on either path.
  await wipe('cookies', () => {
    const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    for (const entry of page.cookie.split(';')) {
      const name = (entry.split('=')[0] ?? '').trim();
      if (name === '') {
        continue;
      }
      page.cookie = `${name}=; ${expired}; path=/`;
      page.cookie = `${name}=; ${expired}; path=${stores.pathname}`;
    }
  });

  m.count(S.APP_ORIGIN_PURGE, failed.length === 0 ? { outcome: 'ok' } : { outcome: 'error', reason: failed.join(',') });
}
