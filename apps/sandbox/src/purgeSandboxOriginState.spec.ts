// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';

import { purgeSandboxOriginState, type SandboxOrigin } from './purgeSandboxOriginState.js';

type Origin = {
  /** The stores the purge wipes. */
  stores: SandboxOrigin;
  /** What each store had wiped, in order. */
  wiped: string[];
};

/** A sandbox origin holding a database, a cache, a worker, both storages and a cookie, whose local storage is blocked. */
function createOrigin(): Origin {
  const wiped: string[] = [];
  const cookies = ['theme=dark'];
  const stores: SandboxOrigin = {
    indexedDB: {
      databases: () => Promise.resolve([{ name: 'app-db', version: 1 }]),
      deleteDatabase(name) {
        wiped.push(`indexedDB:${name}`);
        // The wipe reads only the request's handlers.
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          request.onsuccess?.call(request, new Event('success'));
        });
        return request;
      },
    },
    caches: {
      keys: () => Promise.resolve(['assets-v1']),
      delete(name) {
        wiped.push(`caches:${name}`);
        return Promise.resolve(true);
      },
    },
    serviceWorker: {
      getRegistrations: () =>
        Promise.resolve([
          // The wipe reads only `unregister`.
          {
            unregister() {
              wiped.push('serviceWorker');
              return Promise.resolve(true);
            },
          } as unknown as ServiceWorkerRegistration,
        ]),
    },
    getLocalStorage: () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    getSessionStorage: () => ({
      clear: () => {
        wiped.push('sessionStorage');
      },
    }),
    document: {
      get cookie() {
        return cookies.join('; ');
      },
      set cookie(value: string) {
        wiped.push(`cookie:${value.split(';')[0] ?? ''}`);
      },
    },
    pathname: '/',
  };
  return { stores, wiped };
}

describe('purgeSandboxOriginState', () => {
  it('As a visitor, I ask for a full reset and every store the sandbox origin holds is wiped even when one of them fails', async () => {
    // Given an origin whose local storage the browser blocks
    const { stores, wiped } = createOrigin();
    const expected: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: (_error, context) => {
          expected.push(context.step);
        },
      }),
    );

    // When
    await purgeSandboxOriginState(stores);

    // Then every other store was wiped, and the blocked one left one breadcrumb
    expect(wiped).toEqual([
      'indexedDB:app-db',
      'caches:assets-v1',
      'serviceWorker',
      'sessionStorage',
      'cookie:theme=',
      'cookie:theme=',
    ]);
    expect(expected).toEqual(['origin_purge']);
  });

  it('As a visitor whose database delete is refused, I ask for a full reset and the rest is still wiped while the database part is reported', async () => {
    // Given an origin whose database delete fails and whose storages are open
    const { stores, wiped } = createOrigin();
    const refusing: SandboxOrigin = {
      ...stores,
      indexedDB: {
        databases: () => Promise.resolve([{ name: 'app-db', version: 1 }]),
        deleteDatabase() {
          // The wipe reads only the request's error and handlers.
          const request = { error: new DOMException('refused', 'UnknownError') } as unknown as IDBOpenDBRequest;
          queueMicrotask(() => {
            request.onerror?.call(request, new Event('error'));
          });
          return request;
        },
      },
      getLocalStorage: () => ({ clear: () => undefined }),
    };
    const refusals: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: error => {
          refusals.push(error instanceof Error ? error.message : String(error));
        },
      }),
    );

    // When
    await purgeSandboxOriginState(refusing);

    // Then
    expect(wiped).toEqual(['caches:assets-v1', 'serviceWorker', 'sessionStorage', 'cookie:theme=', 'cookie:theme=']);
    expect(refusals).toEqual(['Failed to delete app-db DB: UnknownError']);
  });
});
