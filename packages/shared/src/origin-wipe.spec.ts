// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { must } from './testing/must.js';
import { deleteAllDatabases, OriginWipeError, wipeOriginStores, type OriginStores } from './origin-wipe.js';

/** A delete request that settles on the next microtask, as the browser fires it, with `error` when refused. */
function deleteRequest(refused: DOMException | null): IDBOpenDBRequest {
  const request = { error: refused } as unknown as IDBOpenDBRequest;
  queueMicrotask(() => {
    if (refused === null) {
      request.onsuccess?.call(request, new Event('success'));
    } else {
      request.onerror?.call(request, new Event('error'));
    }
  });
  return request;
}

/** An origin holding `names` as databases, a cache and a worker, recording what it wiped in order. */
function origin(names: string[], refuse: string[] = []): { stores: OriginStores; wiped: string[] } {
  const wiped: string[] = [];
  return {
    wiped,
    stores: {
      indexedDB: {
        databases: () => Promise.resolve(names.map(name => ({ name, version: 1 }))),
        deleteDatabase: name => {
          wiped.push(`db:${name}`);
          return deleteRequest(refuse.includes(name) ? new DOMException('refused', 'UnknownError') : null);
        },
      },
      caches: {
        keys: () => Promise.resolve(['shell']),
        delete: key => {
          wiped.push(`cache:${key}`);
          return Promise.resolve(true);
        },
      },
      serviceWorker: {
        getRegistrations: () =>
          Promise.resolve([
            {
              unregister: () => {
                wiped.push('worker');
                return Promise.resolve(true);
              },
            } as unknown as ServiceWorkerRegistration,
          ]),
      },
    },
  };
}

describe('wipeOriginStores', () => {
  it('As a user resetting an origin, every store is emptied and the wipe resolves', async () => {
    // Given
    const { stores, wiped } = origin(['dotli', 'smoldot']);

    // When
    await wipeOriginStores(stores);

    // Then
    expect(wiped).toEqual(['db:dotli', 'db:smoldot', 'cache:shell', 'worker']);
  });

  it('As a user whose database delete is refused, the other stores are still emptied and the wipe names the database part', async () => {
    // Given
    const { stores, wiped } = origin(['dotli'], ['dotli']);

    // When
    const wipe = wipeOriginStores(stores);

    // Then
    const error: unknown = await wipe.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OriginWipeError);
    expect([...(error as OriginWipeError).failures.keys()]).toEqual(['indexeddb']);
    expect(wiped).toEqual(['db:dotli', 'cache:shell', 'worker']);
  });

  it('As a user on a browser that cannot list its databases, the wipe names the database part', async () => {
    // Given
    const { stores } = origin([]);
    const unlistable = { deleteDatabase: stores.indexedDB?.deleteDatabase } as unknown as OriginStores['indexedDB'];

    // When
    const error: unknown = await wipeOriginStores({ ...stores, indexedDB: unlistable }).catch((err: unknown) => err);

    // Then
    expect([...(error as OriginWipeError).failures.keys()]).toEqual(['indexeddb']);
  });

  it('As a user on a browser without caches or service workers, the wipe resolves with nothing to report', async () => {
    // Given
    const { stores, wiped } = origin(['dotli']);

    // When
    await wipeOriginStores({ ...stores, caches: null, serviceWorker: null });

    // Then
    expect(wiped).toEqual(['db:dotli']);
  });
});

describe('deleteAllDatabases', () => {
  it('As the protocol frame, I delete every database but the ones I keep, and learn which went', async () => {
    // Given
    const { stores, wiped } = origin(['dotli', 'smoldot-paseo']);

    // When
    const deleted = await deleteAllDatabases(must(stores.indexedDB, 'a database factory'), ['dotli']);

    // Then
    expect(deleted).toEqual(['smoldot-paseo']);
    expect(wiped).toEqual(['db:smoldot-paseo']);
  });
});
