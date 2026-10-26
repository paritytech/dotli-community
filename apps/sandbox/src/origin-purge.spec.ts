// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';

import { purgeSandboxOriginState, type SandboxOrigin } from './origin-purge.js';

type Origin = {
  stores: SandboxOrigin;
  /** What each store had wiped, in order. */
  wiped: string[];
};

/** A sandbox origin holding a database, a cache, a worker, both storages and a cookie, whose local storage is blocked. */
function origin(): Origin {
  const wiped: string[] = [];
  const cookies = ['theme=dark'];
  const stores: SandboxOrigin = {
    indexedDB: {
      databases: () => Promise.resolve([{ name: 'app-db', version: 1 }]),
      deleteDatabase: name => {
        wiped.push(`indexedDB:${name}`);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          request.onsuccess?.call(request, new Event('success'));
        });
        return request;
      },
    },
    caches: {
      keys: () => Promise.resolve(['assets-v1']),
      delete: name => {
        wiped.push(`caches:${name}`);
        return Promise.resolve(true);
      },
    },
    serviceWorker: {
      getRegistrations: () =>
        Promise.resolve([
          {
            unregister: () => {
              wiped.push('serviceWorker');
              return Promise.resolve(true);
            },
          } as unknown as ServiceWorkerRegistration,
        ]),
    },
    localStorage: () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    sessionStorage: () => ({
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
  it('As a visitor who asked for a full reset, every store the sandbox origin holds is wiped even when one of them fails', async () => {
    // Given an origin whose local storage the browser blocks
    const { stores, wiped } = origin();
    const expected: string[] = [];
    const unbind = bindCaptureSink({
      exception: () => undefined,
      expected: (_err, ctx) => {
        expected.push(ctx.step);
      },
    });

    // When
    await purgeSandboxOriginState(stores);
    unbind();

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

  it('As a visitor whose database delete is refused, the purge still wipes the rest and reports the database part', async () => {
    // Given an origin whose database delete fails and whose storages are open
    const { stores, wiped } = origin();
    const refusing: SandboxOrigin = {
      ...stores,
      indexedDB: {
        databases: () => Promise.resolve([{ name: 'app-db', version: 1 }]),
        deleteDatabase: () => {
          const request = { error: new DOMException('refused', 'UnknownError') } as unknown as IDBOpenDBRequest;
          queueMicrotask(() => {
            request.onerror?.call(request, new Event('error'));
          });
          return request;
        },
      },
      localStorage: () => ({ clear: () => undefined }),
    };
    const refusals: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: err => {
          refusals.push(err instanceof Error ? err.message : String(err));
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
