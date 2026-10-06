// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { packArchive } from '@dotli/content';

const ORIGIN = 'https://coffer.app.dot.li';

type WorkerScope = EventTarget;

/** What the sandbox pages the worker controls were sent, across every page. */
let pageInbox: unknown[] = [];

/**
 * Start a worker instance the way the browser does: fresh module state over
 * the origin's existing storage. Calling it a second time is the restart
 * Chrome performs after stopping an idle worker.
 */
async function startWorker(): Promise<WorkerScope> {
  vi.resetModules();
  const scope = Object.assign(new EventTarget(), {
    location: new URL(`${ORIGIN}/app-sw.js`),
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () =>
        Promise.resolve([
          {
            postMessage: (message: unknown) => {
              pageInbox.push(message);
            },
          },
        ]),
    },
  });
  vi.stubGlobal('self', scope);
  await import('../src/app-sw.js');
  return scope;
}

/** Hand the worker an archive as the sandbox page does, and wait for every write it keeps alive. */
async function setArchive(scope: WorkerScope, files: Record<string, string>): Promise<unknown[]> {
  const encoder = new TextEncoder();
  const { packed, index } = packArchive(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)])),
  );
  return sendArchive(scope, packed, index);
}

async function sendArchive(scope: WorkerScope, packed: unknown, index: unknown): Promise<unknown[]> {
  const replies: unknown[] = [];
  const kept: Promise<unknown>[] = [];
  const event = Object.assign(new Event('message'), {
    data: { type: 'SET_ARCHIVE', packed, index },
    ports: [],
    source: {
      postMessage: (message: unknown) => {
        replies.push(message);
      },
    },
    waitUntil: (promise: Promise<unknown>) => {
      kept.push(promise);
    },
  });
  scope.dispatchEvent(event);
  await Promise.all(kept);
  return replies;
}

/** An IndexedDB that refuses to open, as a storage-starved or blocked origin's does. */
function brokenIndexedDb(): unknown {
  return {
    open: () => {
      const request: { error: DOMException | null; onerror: (() => void) | null } = { error: null, onerror: null };
      setTimeout(() => {
        request.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        request.onerror?.();
      }, 0);
      return request;
    },
  };
}

/** Issue a fetch through the worker. `undefined` means it let the request go to the network. */
async function request(scope: WorkerScope, path: string): Promise<Response | undefined> {
  let answer: Response | Promise<Response> | undefined;
  const event = Object.assign(new Event('fetch'), {
    request: { url: `${ORIGIN}${path}`, mode: 'no-cors' },
    respondWith: (response: Response | Promise<Response>) => {
      answer = response;
    },
  });
  scope.dispatchEvent(event);
  return answer === undefined ? undefined : await answer;
}

async function replacePersistedArchive(archive: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('dotli-app-sw', 1);
    opening.onsuccess = () => {
      resolve(opening.result);
    };
    opening.onerror = () => {
      reject(opening.error ?? new Error('archive fixture DB open failed'));
    };
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('archive', 'readwrite');
      tx.objectStore('archive').put(archive, 'current');
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('archive fixture write failed'));
      };
    });
  } finally {
    db.close();
  }
}

describe('app service worker', () => {
  let network: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pageInbox = [];
    vi.stubGlobal('indexedDB', new IDBFactory());
    network = vi.fn(() =>
      Promise.resolve(new Response('<!doctype html>shell', { headers: { 'Content-Type': 'text/html' } })),
    );
    vi.stubGlobal('fetch', network);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('As a user, a chunk the app imports after the browser restarted the idle worker still comes from the archive', async () => {
    // Given
    const first = await startWorker();
    expect(await setArchive(first, { 'index.html': '<html></html>', '_nuxt/late.js': 'export default 1;' })).toEqual([
      { type: 'ARCHIVE_READY' },
    ]);

    // When
    const restarted = await startWorker();
    const response = await request(restarted, '/_nuxt/late.js');

    // Then
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('application/javascript');
    expect(await response?.text()).toBe('export default 1;');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a user, the archive a restarted worker serves is the latest one the page sent', async () => {
    // Given
    const first = await startWorker();
    await setArchive(first, { 'index.html': '<html></html>', 'old.js': 'old' });
    await setArchive(first, { 'index.html': '<html></html>', 'new.js': 'new' });

    // When
    const restarted = await startWorker();
    const fresh = await request(restarted, '/new.js');
    const stale = await request(restarted, '/old.js');

    // Then
    expect(await fresh?.text()).toBe('new');
    expect(stale).toBeUndefined();
  });

  it('As a user, the sandbox page still loads its own assets before any archive arrives', async () => {
    // Given
    const scope = await startWorker();

    // When
    const shellAsset = await request(scope, '/assets/index.js');
    const appPath = await request(scope, '/dotli-app/main.js');

    // Then
    expect(await shellAsset?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
    expect(appPath?.status).toBe(503);
  });

  it('keeps a newly received archive when an older persisted read finishes', async () => {
    const first = await startWorker();
    await setArchive(first, { 'main.js': 'old' });
    const restarted = await startWorker();
    let replacement: Promise<unknown[]> | undefined;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(function (this: IDBObjectStore, key) {
      get.mockRestore();
      const read = this.get(key);
      read.addEventListener(
        'success',
        () => {
          replacement = setArchive(restarted, { 'main.js': 'new' });
        },
        { once: true },
      );
      return read;
    });

    const response = await request(restarted, '/main.js');
    await replacement;

    expect(await response?.text()).toBe('new');
    expect(await (await request(await startWorker(), '/main.js'))?.text()).toBe('new');
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'non-buffer payload', packed: 'bad', index: [] },
    { name: 'non-array index', packed: new ArrayBuffer(1), index: {} },
    { name: 'non-string path', packed: new ArrayBuffer(1), index: [{ p: 1, o: 0, l: 1 }] },
    { name: 'negative offset', packed: new ArrayBuffer(1), index: [{ p: 'main.js', o: -1, l: 1 }] },
    { name: 'fractional length', packed: new ArrayBuffer(1), index: [{ p: 'main.js', o: 0, l: 0.5 }] },
    { name: 'out-of-bounds range', packed: new ArrayBuffer(1), index: [{ p: 'main.js', o: 1, l: 1 }] },
    { name: 'host-owned path', packed: new ArrayBuffer(1), index: [{ p: 'polkavm-runtime/host.js', o: 0, l: 1 }] },
    {
      name: 'encoded host-owned path',
      packed: new ArrayBuffer(1),
      index: [{ p: '/%70olkavm-runtime/host.js', o: 0, l: 1 }],
    },
  ])('rejects a live $name without replacing the accepted archive', async ({ packed, index }) => {
    const scope = await startWorker();
    await setArchive(scope, { 'main.js': 'accepted' });

    expect(await sendArchive(scope, packed, index)).toEqual([expect.objectContaining({ type: 'ARCHIVE_ERROR' })]);
    expect(await (await request(scope, '/main.js'))?.text()).toBe('accepted');
    expect(await (await request(await startWorker(), '/main.js'))?.text()).toBe('accepted');
  });

  it.each([
    { name: 'non-buffer payload', packed: 'bad', index: [] },
    { name: 'out-of-bounds range', packed: new ArrayBuffer(1), index: [{ p: 'main.js', o: 0, l: 2 }] },
    { name: 'host-owned path', packed: new ArrayBuffer(1), index: [{ p: 'polkavm-runtime/host.js', o: 0, l: 1 }] },
    {
      name: 'encoded host-owned path',
      packed: new ArrayBuffer(1),
      index: [{ p: '/%70olkavm-runtime/host.js', o: 0, l: 1 }],
    },
  ])('does not serve a persisted $name and accepts a fresh valid archive', async ({ packed, index }) => {
    const first = await startWorker();
    await setArchive(first, { 'main.js': 'original' });
    await replacePersistedArchive({ packed, index });
    const restarted = await startWorker();

    expect((await request(restarted, '/dotli-app/main.js'))?.status).toBe(503);
    expect(await request(restarted, '/polkavm-runtime/host.js')).toBeUndefined();
    expect(network).not.toHaveBeenCalled();

    expect(await setArchive(restarted, { 'main.js': 'fresh' })).toEqual([{ type: 'ARCHIVE_READY' }]);
    expect(await (await request(restarted, '/dotli-app/main.js'))?.text()).toBe('fresh');
  });

  it('leaves host runtime requests on the network before and after archive restoration', async () => {
    const first = await startWorker();
    await setArchive(first, { 'main.js': 'app' });
    const restarted = await startWorker();

    expect(await request(restarted, '/polkavm-runtime/host.js')).toBeUndefined();
    expect(await (await request(restarted, '/main.js'))?.text()).toBe('app');
    expect(await request(restarted, '/polkavm-runtime/host.js')).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });

  it('As an operator, an archive the worker could not keep for its next restart is reported to the page', async () => {
    // Given an origin whose storage refuses the write
    vi.stubGlobal('indexedDB', brokenIndexedDb());
    const scope = await startWorker();

    // When the page hands over its archive
    const replies = await setArchive(scope, { 'index.html': '<html></html>', 'app.js': '1' });

    // Then the page can still serve now, and hears why a restart would not
    expect(replies).toEqual([
      { type: 'ARCHIVE_READY' },
      {
        type: 'ARCHIVE_FAILURE',
        stage: 'persist',
        name: 'QuotaExceededError',
        message: 'The quota has been exceeded.',
      },
    ]);
  });

  it('As an operator, a restarted worker that cannot read the archive back is reported to the page', async () => {
    // Given a restarted worker over storage it cannot read
    vi.stubGlobal('indexedDB', brokenIndexedDb());
    const scope = await startWorker();

    // When the app asks it for a file
    const response = await request(scope, '/dotli-app/main.js');

    // Then the request fails as before, and the page hears why
    expect(response?.status).toBe(503);
    await vi.waitFor(() => {
      expect(pageInbox).toEqual([
        {
          type: 'ARCHIVE_FAILURE',
          stage: 'restore',
          name: 'QuotaExceededError',
          message: 'The quota has been exceeded.',
        },
      ]);
    });
  });
});
