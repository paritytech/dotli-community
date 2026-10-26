// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { purgeWorkerCaches } from './worker-caches.js';

describe('purgeWorkerCaches', () => {
  it('As an operator, I purge the chain caches and the smoldot database is deleted and named', async () => {
    // Given a factory that records what it deletes
    const deleted: string[] = [];
    const factory: Pick<IDBFactory, 'deleteDatabase'> = {
      deleteDatabase: name => {
        deleted.push(name);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          request.onsuccess?.call(request, new Event('success'));
        });
        return request;
      },
    };

    // When the caches are purged
    const purged = await purgeWorkerCaches(factory);

    // Then the smoldot database is deleted and named
    expect(deleted).toEqual(['dotli-smoldot-db']);
    expect(purged).toEqual(['dotli-smoldot-db']);
  });
});
