// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Window } from 'happy-dom';
import {
  addRecentLabel,
  clearInstalledExecutableCache,
  evictCachedInstalledExecutable,
  getCachedInstalledExecutable,
  getRecentLabels,
  reconcileInstalledExecutable,
  removeRecentLabel,
  setCachedInstalledExecutable,
  type InstalledExecutable,
} from '../src/cid-cache.js';
// Vitest's happy-dom environment omits global storage in isolated workers.
vi.stubGlobal('localStorage', new Window({ url: 'https://host.dot.li/' }).localStorage);

// Recent labels live in localStorage. Installed executables live in IndexedDB.

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

const NETWORK = 'paseo-next-v2';
const OTHER_NETWORK = 'previewnet';
const ROOT_MANIFEST = '{"$v":1,"displayName":"App","description":"","icon":{"cid":"bafy-icon","format":"png"}}';
const OLD_EXECUTABLE: InstalledExecutable = {
  contenthash: 'bafy-old',
  executableManifest: '{"$v":1,"kind":"app","appVersion":[1,0,0]}',
  rootManifest: ROOT_MANIFEST,
};
const NEW_EXECUTABLE: InstalledExecutable = {
  contenthash: 'bafy-new',
  executableManifest: '{"$v":1,"kind":"app","appVersion":[2,0,0]}',
  rootManifest: ROOT_MANIFEST,
};

interface RawInstalledExecutable extends InstalledExecutable {
  label: string;
  network: string;
  modality: string;
  timestamp: number;
}

async function openInstalledExecutableDb(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('dotli-installed-executables', 1);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('DB open failed'));
    };
  });
}

async function readRawEntry(
  label: string,
  network = NETWORK,
  modality = 'app',
): Promise<RawInstalledExecutable | undefined> {
  const db = await openInstalledExecutableDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('installed_executables', 'readonly');
    const req = tx.objectStore('installed_executables').get([network, modality, label]);
    req.onsuccess = () => {
      resolve(req.result as RawInstalledExecutable | undefined);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('read failed'));
    };
  });
}

describe('installed executable IndexedDB cache', () => {
  beforeEach(async () => {
    await clearInstalledExecutableCache();
  });

  it('stores the manifest and contenthash as one record', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);

    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({
      kind: 'hit',
      executable: OLD_EXECUTABLE,
    });
  });

  it('treats a record written before root manifests were retained as a cache miss', async () => {
    const db = await openInstalledExecutableDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('installed_executables', 'readwrite');
      tx.objectStore('installed_executables').put({
        label: 'legacy',
        network: NETWORK,
        modality: 'app',
        timestamp: 1,
        contenthash: OLD_EXECUTABLE.contenthash,
        executableManifest: OLD_EXECUTABLE.executableManifest,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await getCachedInstalledExecutable('legacy', NETWORK, 'app')).toEqual({ kind: 'miss' });
  });

  it('scopes records by network and modality', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);
    await setCachedInstalledExecutable('myapp', OTHER_NETWORK, 'app', NEW_EXECUTABLE);
    await setCachedInstalledExecutable('myapp', NETWORK, 'worker', {
      contenthash: 'bafy-worker',
      rootManifest: null,
      executableManifest:
        '{"$v":1,"kind":"worker","appVersion":[1,0,0],"entrypoint":"worker.js","includes":{"chat":false,"pocket":false}}',
    });

    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({
      kind: 'hit',
      executable: OLD_EXECUTABLE,
    });
    expect(await getCachedInstalledExecutable('myapp', OTHER_NETWORK, 'app')).toEqual({
      kind: 'hit',
      executable: NEW_EXECUTABLE,
    });
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'widget')).toEqual({ kind: 'miss' });
  });

  it('atomically replaces both fields and refreshes the timestamp', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    try {
      await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);
      const before = await readRawEntry('myapp');

      await setCachedInstalledExecutable('myapp', NETWORK, 'app', NEW_EXECUTABLE);

      const after = await readRawEntry('myapp');
      expect(after?.contenthash).toBe(NEW_EXECUTABLE.contenthash);
      expect(after?.executableManifest).toBe(NEW_EXECUTABLE.executableManifest);
      expect(after?.rootManifest).toBe(NEW_EXECUTABLE.rootManifest);
      expect(after?.timestamp ?? 0).toBeGreaterThan(before?.timestamp ?? 0);
    } finally {
      now.mockRestore();
    }
  });
});

describe('reconcileInstalledExecutable', () => {
  beforeEach(async () => {
    await clearInstalledExecutableCache();
  });

  it('preserves the complete pair on a warm reload with the same contenthash', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);

    expect(
      await reconcileInstalledExecutable(
        'myapp',
        NETWORK,
        'app',
        OLD_EXECUTABLE,
        OLD_EXECUTABLE.contenthash,
        { app: OLD_EXECUTABLE.executableManifest, root: ROOT_MANIFEST },
      ),
    ).toEqual({ kind: 'match' });
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({
      kind: 'hit',
      executable: OLD_EXECUTABLE,
    });
  });

  it('evicts the old pair when contenthash changes without caching an unpaired hash', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);

    expect(
      await reconcileInstalledExecutable(
        'myapp',
        NETWORK,
        'app',
        OLD_EXECUTABLE,
        NEW_EXECUTABLE.contenthash,
        { app: NEW_EXECUTABLE.executableManifest, root: ROOT_MANIFEST },
      ),
    ).toEqual({
      kind: 'update',
      contenthash: NEW_EXECUTABLE.contenthash,
    });
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({ kind: 'miss' });

    await setCachedInstalledExecutable('myapp', NETWORK, 'app', NEW_EXECUTABLE);
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({
      kind: 'hit',
      executable: NEW_EXECUTABLE,
    });
  });

  it('evicts the pair when the executable manifest changes at the same contenthash', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);

    expect(
      await reconcileInstalledExecutable(
        'myapp',
        NETWORK,
        'app',
        OLD_EXECUTABLE,
        OLD_EXECUTABLE.contenthash,
        { app: NEW_EXECUTABLE.executableManifest, root: ROOT_MANIFEST },
      ),
    ).toEqual({
      kind: 'update',
      contenthash: OLD_EXECUTABLE.contenthash,
    });
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({ kind: 'miss' });
  });

  it('evicts the record when the root manifest changes at the same contenthash', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);

    expect(
      await reconcileInstalledExecutable(
        'myapp',
        NETWORK,
        'app',
        OLD_EXECUTABLE,
        OLD_EXECUTABLE.contenthash,
        { app: OLD_EXECUTABLE.executableManifest, root: '{"$v":2}' },
      ),
    ).toEqual({ kind: 'update', contenthash: OLD_EXECUTABLE.contenthash });
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({ kind: 'miss' });
  });

  it('evicts the pair when contenthash is cleared', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);

    expect(await reconcileInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE, null, { root: null, app: null })).toEqual({
      kind: 'cleared',
    });
    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({ kind: 'miss' });
  });
});

describe('evictCachedInstalledExecutable', () => {
  beforeEach(async () => {
    await clearInstalledExecutableCache();
  });

  it('removes only the selected scoped record', async () => {
    await setCachedInstalledExecutable('myapp', NETWORK, 'app', OLD_EXECUTABLE);
    await setCachedInstalledExecutable('myapp', OTHER_NETWORK, 'app', NEW_EXECUTABLE);

    await evictCachedInstalledExecutable('myapp', NETWORK, 'app');

    expect(await getCachedInstalledExecutable('myapp', NETWORK, 'app')).toEqual({ kind: 'miss' });
    expect(await getCachedInstalledExecutable('myapp', OTHER_NETWORK, 'app')).toEqual({
      kind: 'hit',
      executable: NEW_EXECUTABLE,
    });
  });
});
