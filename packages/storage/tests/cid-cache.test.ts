// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRecentLabels,
  addRecentLabel,
  removeRecentLabel,
  getCachedCid,
  getCachedCidResult,
  setCachedCid,
  evictCachedCid,
} from '../src/cid-cache.js';
import { getDb } from '../src/db.js';

// Recent labels live in localStorage (happy-dom). CIDs live in IndexedDB (fake-indexeddb).

describe('getRecentLabels', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when nothing stored', () => {
    expect(getRecentLabels()).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    localStorage.setItem('dotli_recent', '');
    expect(getRecentLabels()).toEqual([]);
  });

  it('returns stored labels', () => {
    localStorage.setItem('dotli_recent', '["myapp","test"]');
    expect(getRecentLabels()).toEqual(['myapp', 'test']);
  });

  it('limits to MAX_RECENT (8) entries', () => {
    const labels = Array.from({ length: 20 }, (_, i) => `label${String(i)}`);
    localStorage.setItem('dotli_recent', JSON.stringify(labels));
    expect(getRecentLabels()).toHaveLength(8);
  });

  it('returns empty array for malformed JSON', () => {
    localStorage.setItem('dotli_recent', 'not-json');
    expect(getRecentLabels()).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    localStorage.setItem('dotli_recent', '{"foo":"bar"}');
    expect(getRecentLabels()).toEqual([]);
  });
});

describe('addRecentLabel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('adds a label to empty list', () => {
    addRecentLabel('myapp');
    expect(getRecentLabels()).toEqual(['myapp']);
  });

  it('prepends new label to front', () => {
    localStorage.setItem('dotli_recent', '["old"]');
    addRecentLabel('new');
    expect(getRecentLabels()).toEqual(['new', 'old']);
  });

  it('deduplicates existing label (moves to front)', () => {
    localStorage.setItem('dotli_recent', '["a","b","c"]');
    addRecentLabel('b');
    expect(getRecentLabels()).toEqual(['b', 'a', 'c']);
  });

  it('limits to MAX_RECENT entries', () => {
    const initial = Array.from({ length: 8 }, (_, i) => `label${String(i)}`);
    localStorage.setItem('dotli_recent', JSON.stringify(initial));
    addRecentLabel('new');
    const result = getRecentLabels();
    expect(result).toHaveLength(8);
    expect(result[0]).toBe('new');
    // Last item from initial should be evicted
    expect(result).not.toContain('label7');
  });

  it('ignores an invalid label', () => {
    addRecentLabel('Not A Label');
    expect(getRecentLabels()).toEqual([]);
  });
});

describe('removeRecentLabel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes a stored label and keeps the rest in order', () => {
    localStorage.setItem('dotli_recent', '["a","b","c"]');
    removeRecentLabel('b');
    expect(getRecentLabels()).toEqual(['a', 'c']);
  });

  it('empties the list when the last label is removed', () => {
    localStorage.setItem('dotli_recent', '["only"]');
    removeRecentLabel('only');
    expect(getRecentLabels()).toEqual([]);
  });

  it('is a no-op for a label that was never stored', () => {
    localStorage.setItem('dotli_recent', '["a"]');
    removeRecentLabel('b');
    expect(getRecentLabels()).toEqual(['a']);
  });
});

const NO_MANIFESTS = { root: null, app: null };
const ROOT = '{"$v":1,"displayName":"DOOM","description":"","icon":{"cid":"bafk","format":"png"}}';
const APP = '{"$v":1,"kind":"app","appVersion":[0,1,9]}';

async function putRawEntry(entry: object): Promise<void> {
  const db = await getDb();
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

async function clearCidStore(): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cids', 'readwrite');
    tx.objectStore('cids').clear();
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('clear failed'));
    };
  });
}

async function readRawEntry(label: string): Promise<{ label: string; cid: string; timestamp: number } | undefined> {
  const db = await getDb();
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
  beforeEach(async () => {
    await clearCidStore();
  });

  it('setCachedCid → getCachedCidResult returns hit', async () => {
    await setCachedCid('myapp', 'bafy123', NO_MANIFESTS);
    expect(await getCachedCidResult('myapp')).toEqual({
      kind: 'hit',
      cid: 'bafy123',
      manifests: NO_MANIFESTS,
    });
  });

  it('keeps the manifest records next to the CID', async () => {
    await setCachedCid('doom', 'bafy-doom', { root: ROOT, app: APP });
    expect(await getCachedCidResult('doom')).toEqual({
      kind: 'hit',
      cid: 'bafy-doom',
      manifests: { root: ROOT, app: APP },
    });
  });

  it('reads an entry cached before manifests were kept as a miss, so the next load re-reads them', async () => {
    await putRawEntry({ label: 'doom', cid: 'bafy-doom', timestamp: Date.now() });
    expect(await getCachedCidResult('doom')).toEqual({ kind: 'miss' });
  });

  it('getCachedCidResult returns miss for unset label', async () => {
    expect(await getCachedCidResult('never-stored')).toEqual({ kind: 'miss' });
  });

  it('legacy getCachedCid collapses miss to null', async () => {
    expect(await getCachedCid('never-stored')).toBeNull();
  });

  it('legacy getCachedCid returns the cid on hit', async () => {
    await setCachedCid('myapp', 'bafy456', NO_MANIFESTS);
    expect(await getCachedCid('myapp')).toEqual({ cid: 'bafy456', manifests: NO_MANIFESTS });
  });

  it('setCachedCid overwrites the existing entry and refreshes timestamp', async () => {
    await setCachedCid('myapp', 'bafy-old', NO_MANIFESTS);
    const first = await readRawEntry('myapp');
    expect(first?.cid).toBe('bafy-old');

    // Force a measurable timestamp delta even on fast machines / coarse clocks.
    await new Promise(resolve => setTimeout(resolve, 2));

    await setCachedCid('myapp', 'bafy-new', NO_MANIFESTS);
    const second = await readRawEntry('myapp');
    expect(second?.cid).toBe('bafy-new');
    expect(second?.timestamp ?? 0).toBeGreaterThan(first?.timestamp ?? 0);
  });
});

describe('evictCachedCid', () => {
  beforeEach(async () => {
    await clearCidStore();
  });

  it('removes an existing entry', async () => {
    await setCachedCid('myapp', 'bafy-doomed', NO_MANIFESTS);
    expect((await getCachedCid('myapp'))?.cid).toBe('bafy-doomed');

    await evictCachedCid('myapp');
    expect(await getCachedCidResult('myapp')).toEqual({ kind: 'miss' });
  });

  it('is a no-op for an unset label', async () => {
    await evictCachedCid('never-stored');
    expect(await getCachedCidResult('never-stored')).toEqual({ kind: 'miss' });
  });
});
