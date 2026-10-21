// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { NetworkName } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { type CidCache, createCidCache } from './cid-cache.js';
import { abortAtCommit } from './testing/abort-at-commit.js';
import { memoryIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let cache: CidCache;

beforeEach(() => {
  idb = memoryIdb();
  cache = createCidCache(idb);
});

const PASEO = NetworkName.PASEO;

const NO_MANIFESTS = { root: null, app: null };
const ROOT = '{"$v":1,"displayName":"DOOM","description":"","icon":{"cid":"bafk","format":"png"}}';
const APP = '{"$v":1,"kind":"app","appVersion":[0,1,9]}';

async function putRawEntry(entry: object): Promise<void> {
  const db = await idb.connect();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cids', 'readwrite');
    tx.objectStore('cids').put(entry);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('put failed'));
    };
  });
}

/** A cache over a fresh database that pushes `committed` into `events` when a write commits. */
function cacheWatchingCommits(events: string[]): CidCache {
  return createCidCache(
    memoryIdb({
      onTransaction: tx => {
        if (tx.mode === 'readwrite') {
          tx.addEventListener('complete', () => {
            events.push('committed');
          });
        }
      },
    }),
  );
}

describe('CID IndexedDB round-trip', () => {
  it('As the resolver, I cache a CID and read it back as a hit', async () => {
    // Given
    await cache.setCachedCid('myapp', PASEO, 'bafy123', NO_MANIFESTS);

    // When / Then
    expect(await cache.getCachedCidResult('myapp', PASEO)).toEqual({
      kind: 'hit',
      cid: 'bafy123',
      manifests: NO_MANIFESTS,
    });
  });

  it('As the resolver, I cache a CID with its manifests and read both back', async () => {
    // Given
    await cache.setCachedCid('doom', PASEO, 'bafy-doom', { root: ROOT, app: APP });

    // When / Then
    expect(await cache.getCachedCidResult('doom', PASEO)).toEqual({
      kind: 'hit',
      cid: 'bafy-doom',
      manifests: { root: ROOT, app: APP },
    });
  });

  it('As the resolver, I read an entry cached before manifests were kept as a miss, so the next load re-reads them', async () => {
    // Given
    await putRawEntry({ label: 'doom', cid: 'bafy-doom', timestamp: Date.now() });

    // When / Then
    expect(await cache.getCachedCidResult('doom', PASEO)).toEqual({ kind: 'miss' });
  });

  it('As the resolver, I read an entry cached on another network as a miss, so that network resolves the name itself', async () => {
    // Given
    await cache.setCachedCid('doom', NetworkName.PREVIEWNET, 'bafy-doom', { root: ROOT, app: APP });

    // When / Then
    expect(await cache.getCachedCidResult('doom', PASEO)).toEqual({ kind: 'miss' });
  });

  it('As the resolver, I read a label never cached and get a miss', async () => {
    // When / Then
    expect(await cache.getCachedCidResult('never-stored', PASEO)).toEqual({ kind: 'miss' });
  });

  it('As a legacy caller, I read a label never cached and get null', async () => {
    // When / Then
    expect(await cache.getCachedCid('never-stored', PASEO)).toBeNull();
  });

  it('As a legacy caller, I read a cached label and get its CID and manifests', async () => {
    // Given
    await cache.setCachedCid('myapp', PASEO, 'bafy456', NO_MANIFESTS);

    // When / Then
    expect(await cache.getCachedCid('myapp', PASEO)).toEqual({ cid: 'bafy456', manifests: NO_MANIFESTS });
  });

  it('As the resolver, I cache a new CID for a cached label and the next read returns the new CID', async () => {
    // Given
    await cache.setCachedCid('myapp', PASEO, 'bafy-old', NO_MANIFESTS);

    // When
    await cache.setCachedCid('myapp', PASEO, 'bafy-new', NO_MANIFESTS);

    // Then
    expect(await cache.getCachedCidResult('myapp', PASEO)).toEqual({
      kind: 'hit',
      cid: 'bafy-new',
      manifests: NO_MANIFESTS,
    });
  });
});

describe('evictCachedCid', () => {
  it('As the host, I evict a cached label and the next read is a miss', async () => {
    // Given
    await cache.setCachedCid('myapp', PASEO, 'bafy-doomed', NO_MANIFESTS);
    expect((await cache.getCachedCid('myapp', PASEO))?.cid).toBe('bafy-doomed');

    // When
    const worked = await cache.evictCachedCid('myapp');

    // Then
    expect(worked).toBe(true);
    expect(await cache.getCachedCidResult('myapp', PASEO)).toEqual({ kind: 'miss' });
  });

  it('As the host, I evict a label never cached and the labels that are cached stay', async () => {
    // Given
    await cache.setCachedCid('kept', PASEO, 'bafy-kept', NO_MANIFESTS);

    // When
    const worked = await cache.evictCachedCid('never-stored');

    // Then
    expect(worked).toBe(true);
    expect(await cache.getCachedCidResult('kept', PASEO)).toEqual({
      kind: 'hit',
      cid: 'bafy-kept',
      manifests: NO_MANIFESTS,
    });
  });
});

describe('cid-cache failure reporting', () => {
  it('As a caller that reloads after a clear, I am told when the CID cache clear failed after it reported itself', async () => {
    // Given the cached connection has closed, as it does under an unloading page
    (await idb.connect()).close();

    // When
    const cleared = await cache.clearCidCache();

    // Then
    expect(cleared).toBe(false);
  });

  it('As a caller that reloads after a clear, I am told when the CID cache clear succeeded', async () => {
    // When
    const cleared = await cache.clearCidCache();

    // Then
    expect(cleared).toBe(true);
  });
});

describe('cid-cache writes and the commit', () => {
  it('As an operator, the CID write latency I read covers the commit', async () => {
    // Given
    const events: string[] = [];
    bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => {
        events.push('latency recorded');
      },
    });
    const watched = cacheWatchingCommits(events);

    // When
    await watched.setCachedCid('myapp', PASEO, 'bafy123', NO_MANIFESTS);

    // Then
    expect(events[0]).toBe('committed');
    expect(events).toContain('latency recorded');
  });

  it('As an operator, a CID write the browser refuses at commit is counted, and the label stays a miss', async () => {
    // Given a database that refuses every commit, as a full quota does
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusing = createCidCache(memoryIdb({ onTransaction: abortAtCommit }));

    // When
    await refusing.setCachedCid('myapp', PASEO, 'bafy123', NO_MANIFESTS);

    // Then
    expect(sentry.counted(S.CACHE_STORAGE)).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'cid_cache', step: 'write' }),
    ]);
    expect(await refusing.getCachedCidResult('myapp', PASEO)).toEqual({ kind: 'miss' });
  });

  it('As the host that reloads after an evict, I find the delete committed by the time evict resolves', async () => {
    // Given
    const events: string[] = [];
    const watched = cacheWatchingCommits(events);
    await watched.setCachedCid('myapp', PASEO, 'bafy-doomed', NO_MANIFESTS);
    events.length = 0;

    // When
    await watched.evictCachedCid('myapp');
    events.push('evict resolved');

    // Then
    expect(events).toEqual(['committed', 'evict resolved']);
  });

  it('As an operator, an evict the browser refuses at commit is counted, so the stale CID it leaves is visible', async () => {
    // Given a cached label, and then a database that refuses every commit
    let refusing = false;
    const flaky = createCidCache(
      memoryIdb({
        onTransaction: tx => {
          if (refusing) {
            abortAtCommit(tx);
          }
        },
      }),
    );
    await flaky.setCachedCid('myapp', PASEO, 'bafy-stale', NO_MANIFESTS);
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    refusing = true;

    // When
    const worked = await flaky.evictCachedCid('myapp');

    // Then the evict is counted as failed, resolves false, and the label still reads its old CID
    expect(worked).toBe(false);
    expect(sentry.counted(S.CACHE_STORAGE)).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'cid_cache', step: 'evict' }),
    ]);
    expect(await flaky.getCachedCidResult('myapp', PASEO)).toEqual({
      kind: 'hit',
      cid: 'bafy-stale',
      manifests: NO_MANIFESTS,
    });
  });
});
