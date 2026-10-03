// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
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
