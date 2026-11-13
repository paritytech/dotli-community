// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { type CidCache, createCidCache } from './cidCache.js';
import { abortAtCommit } from './testing/abortAtCommit.js';
import { createMemoryIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let cache: CidCache;

beforeEach(() => {
  idb = createMemoryIdb();
  cache = createCidCache({ idb });
});

const PASEO = 'paseo-next-v2';

const NO_MANIFESTS = { root: null, app: null, owner: null };
const OWNER = `0x${'ab'.repeat(20)}`;
const ROOT = '{"$v":1,"displayName":"DOOM","description":"","icon":{"cid":"bafk","format":"png"}}';
const APP = '{"$v":1,"kind":"app","appVersion":[0,1,9]}';

async function putRawEntry(entry: object): Promise<void> {
  const db = await idb.connect();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('cids', 'readwrite');
    transaction.objectStore('cids').put(entry);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('put failed'));
    };
  });
}

/** A cache over a fresh database that pushes `committed` into `events` when a write commits. */
function createCacheWatchingCommits(events: string[]): CidCache {
  return createCidCache({
    idb: createMemoryIdb({
      onTransaction: transaction => {
        if (transaction.mode === 'readwrite') {
          transaction.addEventListener('complete', () => {
            events.push('committed');
          });
        }
      },
    }),
  });
}

describe('CID IndexedDB round-trip', () => {
  it('As the resolver, I cache a CID and read it back as a hit', async () => {
    // Given
    await cache.set({ label: 'myapp', network: PASEO, cid: 'bafy123', manifests: NO_MANIFESTS });

    // When
    const cached = await cache.get('myapp', PASEO);

    // Then
    expect(cached).toEqual({ cid: 'bafy123', manifests: NO_MANIFESTS });
  });

  it.each([
    {
      entry: 'an entry cached before manifests were kept',
      store: () => putRawEntry({ label: 'doom', cid: 'bafy-doom', timestamp: Date.now() }),
    },
    {
      entry: 'an entry cached without its owner',
      store: () => cache.set({ label: 'doom', network: PASEO, cid: 'bafy-doom', manifests: { root: ROOT, app: APP } }),
    },
    {
      entry: 'an entry cached on another network',
      store: () =>
        cache.set({
          label: 'doom',
          network: 'previewnet',
          cid: 'bafy-doom',
          manifests: { root: ROOT, app: APP, owner: OWNER },
        }),
    },
    {
      entry: 'a label never cached',
      store: () => Promise.resolve(),
    },
  ])('As the resolver, I read $entry as a miss, so the name resolves again', async ({ store }) => {
    // Given
    await store();

    // When
    const cached = await cache.get('doom', PASEO);

    // Then
    expect(cached).toBeNull();
  });

  it('As the resolver, I cache a new CID for a cached label and the next read returns the new CID', async () => {
    // Given
    await cache.set({ label: 'myapp', network: PASEO, cid: 'bafy-old', manifests: NO_MANIFESTS });

    // When
    await cache.set({ label: 'myapp', network: PASEO, cid: 'bafy-new', manifests: NO_MANIFESTS });

    // Then
    expect(await cache.get('myapp', PASEO)).toEqual({ cid: 'bafy-new', manifests: NO_MANIFESTS });
  });
});

describe('cidCache.evict', () => {
  it('As the host, I evict a cached label and the next read is a miss', async () => {
    // Given
    await cache.set({ label: 'myapp', network: PASEO, cid: 'bafy-doomed', manifests: NO_MANIFESTS });

    // When
    const worked = await cache.evict('myapp');

    // Then
    expect(worked).toBe(true);
    expect(await cache.get('myapp', PASEO)).toBeNull();
  });

  it('As the host, I evict a label never cached and the labels that are cached stay', async () => {
    // Given
    await cache.set({ label: 'kept', network: PASEO, cid: 'bafy-kept', manifests: NO_MANIFESTS });

    // When
    const worked = await cache.evict('never-stored');

    // Then
    expect(worked).toBe(true);
    expect(await cache.get('kept', PASEO)).toEqual({ cid: 'bafy-kept', manifests: NO_MANIFESTS });
  });
});

describe('cid-cache failure reporting', () => {
  it('As a page whose CID cache read fails, I get null and the failure is reported', async () => {
    // Given the cached connection has closed, as it does under an unloading page
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    (await idb.connect()).close();

    // When
    const cached = await cache.get('myapp', PASEO);

    // Then the read is a miss, counted as a failed read, and its latency is still recorded
    expect(cached).toBeNull();
    expect(sentry.counted('cache.storage')).toEqual([
      { outcome: 'error', reason: 'InvalidStateError', surface: 'cid_cache', step: 'read' },
    ]);
    expect(sentry.distributions.map(distribution => distribution.name)).toEqual(['dotli.cache.read_latency']);
  });

  it('As a caller that reloads after a clear, I am told when the CID cache clear failed after it reported itself', async () => {
    // Given the cached connection has closed, as it does under an unloading page
    (await idb.connect()).close();

    // When
    const cleared = await cache.clear();

    // Then
    expect(cleared).toBe(false);
  });

  it('As a caller that reloads after a clear, I am told when the CID cache clear succeeded', async () => {
    // When
    const cleared = await cache.clear();

    // Then
    expect(cleared).toBe(true);
  });
});

describe('cid-cache writes and the commit', () => {
  it('As an operator, I read a CID write latency that covers the commit', async () => {
    // Given
    const events: string[] = [];
    bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => {
        events.push('latency recorded');
      },
    });
    const watched = createCacheWatchingCommits(events);

    // When
    await watched.set({ label: 'myapp', network: PASEO, cid: 'bafy123', manifests: NO_MANIFESTS });

    // Then
    expect(events[0]).toBe('committed');
    expect(events).toContain('latency recorded');
  });

  it('As an operator, I count a CID write the browser refuses at commit, and the label stays a miss', async () => {
    // Given a database that refuses every commit, as a full quota does
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusing = createCidCache({ idb: createMemoryIdb({ onTransaction: abortAtCommit }) });

    // When
    await refusing.set({ label: 'myapp', network: PASEO, cid: 'bafy123', manifests: NO_MANIFESTS });

    // Then
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'cid_cache', step: 'write' }),
    ]);
    expect(await refusing.get('myapp', PASEO)).toBeNull();
  });

  it('As the host that reloads after an evict, I find the delete committed by the time evict resolves', async () => {
    // Given
    const events: string[] = [];
    const watched = createCacheWatchingCommits(events);
    await watched.set({ label: 'myapp', network: PASEO, cid: 'bafy-doomed', manifests: NO_MANIFESTS });
    events.length = 0;

    // When
    await watched.evict('myapp');
    events.push('evict resolved');

    // Then
    expect(events).toEqual(['committed', 'evict resolved']);
  });

  it('As an operator, I count an evict the browser refuses at commit, so the stale CID it leaves is visible', async () => {
    // Given a cached label, and then a database that refuses every commit
    let refusing = false;
    const flaky = createCidCache({
      idb: createMemoryIdb({
        onTransaction: transaction => {
          if (refusing) {
            abortAtCommit(transaction);
          }
        },
      }),
    });
    await flaky.set({ label: 'myapp', network: PASEO, cid: 'bafy-stale', manifests: NO_MANIFESTS });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    refusing = true;

    // When
    const worked = await flaky.evict('myapp');

    // Then the evict is counted as failed, resolves false, and the label still reads its old CID
    expect(worked).toBe(false);
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'cid_cache', step: 'evict' }),
    ]);
    expect(await flaky.get('myapp', PASEO)).toEqual({ cid: 'bafy-stale', manifests: NO_MANIFESTS });
  });
});
