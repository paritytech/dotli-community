// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { packArchive } from '@dotli/content';

import { startAppServiceWorker, type AppServiceWorkerDeps } from './app-service-worker.js';

const ORIGIN = 'https://coffer.app.dot.li';

type WorkerScope = EventTarget;

/** Every message the worker posted to the pages it controls. */
let pageInbox: unknown[] = [];
const pageListeners = new Set<() => void>();

/** Resolves once the worker posts its next message to its pages. */
function nextPageMessage(): Promise<void> {
  return new Promise(resolve => {
    const heard = (): void => {
      pageListeners.delete(heard);
      resolve();
    };
    pageListeners.add(heard);
  });
}

/** The origin's storage and network, which outlive a worker across its restarts. */
interface Origin {
  indexedDB: IDBFactory;
  fetch: typeof fetch;
}

/** A fresh worker over the origin's existing storage. A second call is Chrome restarting a stopped idle worker. */
function startWorker(origin: Origin, devServer = false): WorkerScope {
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
              for (const heard of [...pageListeners]) {
                heard();
              }
            },
          },
        ]),
    },
  });
  startAppServiceWorker({ scope: scope as unknown as AppServiceWorkerDeps['scope'], ...origin, devServer });
  return scope;
}

/** Hands over an archive as the sandbox page does, and waits for every write the worker keeps alive. */
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

/** Hands over an archive as the sandbox page does, on a port of its own, and keeps what reached the page-wide channel. */
async function setArchiveOnPort(
  scope: WorkerScope,
  data: Record<string, unknown>,
): Promise<{ portReply: Promise<unknown>; pageReplies: unknown[]; close: () => void }> {
  const channel = new MessageChannel();
  const portReply = new Promise<unknown>(resolve => {
    channel.port1.onmessage = (event: MessageEvent) => {
      resolve(event.data);
    };
  });
  const pageReplies: unknown[] = [];
  const kept: Promise<unknown>[] = [];
  const event = Object.assign(new Event('message'), {
    data,
    ports: [channel.port2],
    source: {
      postMessage: (message: unknown) => {
        pageReplies.push(message);
      },
    },
    waitUntil: (promise: Promise<unknown>) => {
      kept.push(promise);
    },
  });
  scope.dispatchEvent(event);
  await Promise.all(kept);
  return {
    portReply,
    pageReplies,
    close: () => {
      channel.port1.close();
    },
  };
}

/** An IndexedDB that refuses to open, as a storage-starved or blocked origin's does. */
function brokenIndexedDb(): IDBFactory {
  return {
    open: () => {
      const request: { error: DOMException | null; onerror: (() => void) | null } = { error: null, onerror: null };
      setTimeout(() => {
        request.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        request.onerror?.();
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;
}

/** An IndexedDB that opens, then aborts every write at commit, as a full quota does. Only `abort` fires. */
function quotaAbortingIndexedDb(): IDBFactory {
  const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  const tx = {
    error: null as DOMException | null,
    oncomplete: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    objectStore: () => ({ put: () => ({}) }),
    abort: () => undefined,
  };
  const db = {
    transaction: () => {
      setTimeout(() => {
        tx.error = quota;
        tx.onabort?.();
      }, 0);
      return tx;
    },
    close: () => undefined,
  };
  return {
    open: () => {
      const request = { result: db, onsuccess: null as (() => void) | null };
      setTimeout(() => {
        request.onsuccess?.();
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;
}

/** `undefined` means the worker let the request through to the network. */
async function request(scope: WorkerScope, path: string, mode: RequestMode = 'no-cors'): Promise<Response | undefined> {
  let answer: Response | Promise<Response> | undefined;
  const event = Object.assign(new Event('fetch'), {
    request: { url: `${ORIGIN}${path}`, mode },
    respondWith: (response: Response | Promise<Response>) => {
      answer = response;
    },
  });
  scope.dispatchEvent(event);
  return answer === undefined ? undefined : await answer;
}

describe('app service worker', () => {
  let network: ReturnType<typeof vi.fn<typeof fetch>>;
  let origin: Origin;

  beforeEach(() => {
    pageInbox = [];
    network = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<!doctype html>shell', { headers: { 'Content-Type': 'text/html' } })),
    );
    origin = { indexedDB: new IDBFactory(), fetch: network };
  });

  it('As a user, a chunk the app imports after the browser restarted the idle worker still comes from the archive', async () => {
    // Given
    const first = startWorker(origin);
    expect(await setArchive(first, { 'index.html': '<html></html>', '_nuxt/late.js': 'export default 1;' })).toEqual([
      { type: 'ARCHIVE_READY' },
    ]);

    // When
    const restarted = startWorker(origin);
    const response = await request(restarted, '/_nuxt/late.js');

    // Then
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('application/javascript');
    expect(await response?.text()).toBe('export default 1;');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a user, the archive a restarted worker serves is the latest one the page sent', async () => {
    // Given
    const first = startWorker(origin);
    await setArchive(first, { 'index.html': '<html></html>', 'old.js': 'old' });
    await setArchive(first, { 'index.html': '<html></html>', 'new.js': 'new' });

    // When
    const restarted = startWorker(origin);
    const fresh = await request(restarted, '/new.js');
    const stale = await request(restarted, '/old.js');

    // Then
    expect(await fresh?.text()).toBe('new');
    expect(stale).toBeUndefined();
  });

  it('As a sandbox page, I hand over an archive with a reply port and only that port hears the acknowledgement', async () => {
    // Given
    const scope = startWorker(origin);
    const { packed, index } = packArchive({ 'index.html': new TextEncoder().encode('<html></html>') });

    // When
    const handoff = await setArchiveOnPort(scope, { type: 'SET_ARCHIVE', packed, index });

    // Then
    expect(handoff.pageReplies).toEqual([]);
    expect(await handoff.portReply).toEqual({ type: 'ARCHIVE_READY' });
    handoff.close();
  });

  it('As a sandbox page, I hand over an empty archive message and its port hears the refusal', async () => {
    // Given
    const scope = startWorker(origin);

    // When
    const handoff = await setArchiveOnPort(scope, { type: 'SET_ARCHIVE' });

    // Then
    expect(handoff.pageReplies).toEqual([]);
    expect(await handoff.portReply).toEqual({
      type: 'ARCHIVE_ERROR',
      reason: 'SET_ARCHIVE missing packed/index payload',
    });
    handoff.close();
  });

  it('As a user, the sandbox page still loads its own assets before any archive arrives', async () => {
    // Given
    const scope = startWorker(origin);

    // When
    const shellAsset = await request(scope, '/assets/index.js');

    // Then
    expect(await shellAsset?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
  });

  it('As an operator, an archive the worker could not keep for its next restart is reported to the page', async () => {
    // Given an origin whose storage refuses the write
    const scope = startWorker({ ...origin, indexedDB: brokenIndexedDb() });

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

  it('As an operator, an archive write the browser aborts at commit is reported to the page instead of holding the worker', async () => {
    // Given an origin whose storage aborts the write at commit
    const scope = startWorker({ ...origin, indexedDB: quotaAbortingIndexedDb() });

    // When the page hands over its archive
    const replies = await setArchive(scope, { 'index.html': '<html></html>', 'app.js': '1' });

    // Then
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
    const scope = startWorker({ ...origin, indexedDB: brokenIndexedDb() });
    const reported = nextPageMessage();

    // When the app asks it for a file
    const response = await request(scope, '/main.js');

    // Then the request goes to the network, and the page hears why
    expect(await response?.text()).toBe('<!doctype html>shell');
    await reported;
    expect(pageInbox).toEqual([
      {
        type: 'ARCHIVE_FAILURE',
        stage: 'restore',
        name: 'QuotaExceededError',
        message: 'The quota has been exceeded.',
      },
    ]);
  });

  it('As a product, an HTML file I fetch from my archive comes back byte for byte', async () => {
    // Given
    const scope = startWorker(origin);
    const template = '<html><head><title>part</title></head><body>part</body></html>';
    await setArchive(scope, { 'index.html': '<html></html>', 'template.html': template });

    // When
    const response = await request(scope, '/template.html');

    // Then
    expect(response?.headers.get('Content-Type')).toBe('text/html');
    expect(await response?.text()).toBe(template);
  });

  it('As a user, a navigation inside the product loads the sandbox page from the network', async () => {
    // Given
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'docs/index.html': '<p>docs</p>' });

    // When
    const response = await request(scope, '/docs/', 'navigate');

    // Then
    expect(response).toBeUndefined();
  });

  it('As a user, a request whose path holds a broken escape reaches the network instead of failing in the worker', async () => {
    // Given a worker holding an archive, and one restarted over it
    const first = startWorker(origin);
    await setArchive(first, { 'index.html': '<html></html>' });
    const restarted = startWorker(origin);

    // When
    const live = await request(first, '/bad%E0%A4%A.js');
    const afterRestart = await request(restarted, '/bad%E0%A4%A.js');

    // Then
    expect(live).toBeUndefined();
    expect(await afterRestart?.text()).toBe('<!doctype html>shell');
  });

  it('As a product, a file whose name holds an escaped space is served from my archive', async () => {
    // Given
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'my file.js': 'spaced()' });

    // When
    const response = await request(scope, '/my%20file.js');

    // Then
    expect(await response?.text()).toBe('spaced()');
  });

  it('As a product that ships a src folder, its files come from my archive', async () => {
    // Given
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'src/main.js': 'main()', '@scope/x.js': 'x()' });

    // When
    const source = await request(scope, '/src/main.js');
    const scoped = await request(scope, '/@scope/x.js');

    // Then
    expect(await source?.text()).toBe('main()');
    expect(await scoped?.text()).toBe('x()');
  });

  it("As a dotli developer on the dev server, the sandbox's own modules reach the network", async () => {
    // Given
    const scope = startWorker(origin, true);
    await setArchive(scope, { 'index.html': '<html></html>', 'src/main.js': 'main()' });

    // When
    const source = await request(scope, '/src/main.js');

    // Then
    expect(source).toBeUndefined();
  });
});
