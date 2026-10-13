// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkName } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import { type CidCache, createCidCache, getRecentLabels } from './cid-cache.js';
import { memoryIdb, type MemoryIdb } from './testing/index.js';
import { IDBDatabase } from 'fake-indexeddb';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let cache: CidCache;

beforeEach(() => {
  idb = memoryIdb();
  cache = createCidCache(idb);
});

const PASEO = NetworkName.PASEO;

/** An origin's storage holding `recent` under the recent-labels key, or nothing. */
function storageWith(recent?: string): Pick<Storage, 'getItem'> {
  return { getItem: key => (key === 'dotli_recent' && recent !== undefined ? recent : null) };
}

describe('getRecentLabels', () => {
  it('As a landing page offline from the shared store, I read my recent names from this origin and get none when nothing is stored', () => {
    // When / Then
    expect(getRecentLabels(storageWith())).toEqual([]);
  });

  it('As a landing page offline from the shared store, I read my recent names from this origin and get none from an empty value', () => {
    // When / Then
    expect(getRecentLabels(storageWith(''))).toEqual([]);
  });

  it('As a landing page offline from the shared store, I read my recent names from this origin and get the stored ones', () => {
    // When / Then
    expect(getRecentLabels(storageWith('["myapp","test"]'))).toEqual(['myapp', 'test']);
  });

  it('As a landing page offline from the shared store, I read my recent names from this origin and get at most 8', () => {
    // When
    const labels = Array.from({ length: 20 }, (_, i) => `label${String(i)}`);

    // Then
    expect(getRecentLabels(storageWith(JSON.stringify(labels)))).toHaveLength(8);
  });

  it('As a landing page offline from the shared store, I read my recent names from this origin and get none from a value that is not JSON', () => {
    // When / Then
    expect(getRecentLabels(storageWith('not-json'))).toEqual([]);
  });

  it('As a landing page offline from the shared store, I read my recent names from this origin and get none from JSON that is not a list', () => {
    // When / Then
    expect(getRecentLabels(storageWith('{"foo":"bar"}'))).toEqual([]);
  });
});

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

async function readRawEntry(label: string): Promise<{ label: string; cid: string; timestamp: number } | undefined> {
  const db = await idb.connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cids', 'readonly');
    const req = tx.objectStore('cids').get(label);
    req.onsuccess = () => {
      resolve(req.result as { label: string; cid: string; timestamp: number } | undefined);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('read failed'));
    };
  });
}

describe('CID IndexedDB round-trip', () => {
  beforeEach(() => {
    // Only the clock, as the fake IndexedDB schedules its events on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('As the resolver, I cache a new CID for a cached label and it replaces the entry with a fresh timestamp', async () => {
    // Given
    await cache.setCachedCid('myapp', PASEO, 'bafy-old', NO_MANIFESTS);
    const first = await readRawEntry('myapp');
    expect(first?.cid).toBe('bafy-old');

    // Coarse clocks would otherwise give both writes the same timestamp.
    vi.setSystemTime((first?.timestamp ?? 0) + 1000);

    // When
    await cache.setCachedCid('myapp', PASEO, 'bafy-new', NO_MANIFESTS);

    // Then
    const second = await readRawEntry('myapp');
    expect(second?.cid).toBe('bafy-new');
    expect(second?.timestamp ?? 0).toBeGreaterThan(first?.timestamp ?? 0);
  });
});

describe('evictCachedCid', () => {
  it('As the host, I evict a cached label and the next read is a miss', async () => {
    // Given
    await cache.setCachedCid('myapp', PASEO, 'bafy-doomed', NO_MANIFESTS);
    expect((await cache.getCachedCid('myapp', PASEO))?.cid).toBe('bafy-doomed');

    // When
    await cache.evictCachedCid('myapp');

    // Then
    expect(await cache.getCachedCidResult('myapp', PASEO)).toEqual({ kind: 'miss' });
  });

  it('As the host, I evict a label never cached and nothing changes', async () => {
    // Given
    await cache.evictCachedCid('never-stored');

    // When / Then
    expect(await cache.getCachedCidResult('never-stored', PASEO)).toEqual({ kind: 'miss' });
  });
});

describe('cid-cache failure reporting', () => {
  const MANIFESTS = { root: null, app: null };
  const captures = { exception: vi.fn(), expected: vi.fn() };

  function failTransactions(err: Error): void {
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw err;
    });
  }

  beforeEach(async () => {
    captures.exception.mockClear();
    captures.expected.mockClear();
    await idb.connect();
    return bindCaptureSink(captures);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As an operator, a connection closing under an unloading page leaves a breadcrumb, not an issue', async () => {
    // Given a connection that is closing
    failTransactions(new DOMException('The database connection is closing.', 'InvalidStateError'));

    // When the cache writes
    await cache.setCachedCid('myapp', NetworkName.PASEO, 'bafy', MANIFESTS);

    // Then the failure is recorded as expected
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'storage',
      step: 'cid_cache_write',
    });
  });

  it('As an operator, a stuck cache reports each failing action once per page', async () => {
    // Given a cache whose every transaction fails
    const failure = new Error('disk gone');
    failTransactions(failure);

    // When it evicts twice
    await cache.evictCachedCid('a');
    await cache.evictCachedCid('b');

    // Then one issue names the storage flow and the evict step
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'storage',
      step: 'cid_cache_evict',
      tags: { kind: 'cid_cache_evict_error' },
    });
  });

  it('As a caller that reloads after a clear, I am told when the CID cache clear failed after it reported itself', async () => {
    // Given
    failTransactions(new DOMException('The database connection is closing.', 'InvalidStateError'));

    // When
    const cleared = await cache.clearCidCache();

    // Then the clear says it failed, after leaving its own breadcrumb rather than an issue
    expect(cleared).toBe(false);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'storage',
      step: 'cid_cache_clear',
    });
  });

  it('As a caller that reloads after a clear, I am told when the CID cache clear succeeded', async () => {
    // When
    const cleared = await cache.clearCidCache();

    // Then
    expect(cleared).toBe(true);
  });
});
