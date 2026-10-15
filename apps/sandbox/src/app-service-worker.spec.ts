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

/**
 * A fresh worker over the origin's existing storage. A second call is Chrome restarting a stopped idle worker.
 * `documents` maps each page's client id to the URL it is open at.
 */
function startWorker(origin: Origin, devServer = false, documents: Record<string, string> = {}): WorkerScope {
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
  startAppServiceWorker({
    scope: scope as unknown as AppServiceWorkerDeps['scope'],
    ...origin,
    devServer,
    clientUrl: id => Promise.resolve(documents[id]),
  });
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
async function request(
  scope: WorkerScope,
  path: string,
  mode: RequestMode = 'no-cors',
  clientId = '',
): Promise<Response | undefined> {
  let answer: Response | Promise<Response> | undefined;
  const event = Object.assign(new Event('fetch'), {
    request: { url: `${ORIGIN}${path}`, mode },
    clientId,
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

  it('As a product, I fetch an HTML file from my archive and it comes back byte for byte', async () => {
    // Given an archive holding an HTML file beside the page
    const scope = startWorker(origin);
    const template = '<html><head><title>part</title></head><body>part</body></html>';
    await setArchive(scope, { 'index.html': '<html></html>', 'template.html': template });

    // When the product fetches it
    const response = await request(scope, '/template.html');

    // Then it arrives typed as HTML and untouched
    expect(response?.headers.get('Content-Type')).toBe('text/html');
    expect(await response?.text()).toBe(template);
  });

  it('As a user, I navigate inside the product and the sandbox page loads from the network', async () => {
    // Given an archive holding the sub-page
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'docs/index.html': '<p>docs</p>' });

    // When the browser navigates to it
    const response = await request(scope, '/docs/', 'navigate');

    // Then the worker leaves it to the network
    expect(response).toBeUndefined();
  });

  it('As a user, I request a path holding a broken escape and it reaches the network instead of failing in the worker', async () => {
    // Given a worker holding an archive, and one restarted over it
    const first = startWorker(origin);
    await setArchive(first, { 'index.html': '<html></html>' });
    const restarted = startWorker(origin);

    // When each is asked for the path
    const live = await request(first, '/bad%E0%A4%A.js');
    const afterRestart = await request(restarted, '/bad%E0%A4%A.js');

    // Then the live worker lets it through, and the restarted one fetches it
    expect(live).toBeUndefined();
    expect(await afterRestart?.text()).toBe('<!doctype html>shell');
  });

  it('As a product, I fetch a file whose name holds an escaped space and it is served from my archive', async () => {
    // Given an archive holding a file with a space in its name
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'my file.js': 'spaced()' });

    // When the product asks for it escaped
    const response = await request(scope, '/my%20file.js');

    // Then the worker decodes the path and serves the file
    expect(await response?.text()).toBe('spaced()');
  });

  it('As a product that ships a src folder, I fetch its files and they come from my archive', async () => {
    // Given an archive with a src folder and an @ path, off the dev server
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'src/main.js': 'main()', '@scope/x.js': 'x()' });

    // When the product asks for both
    const source = await request(scope, '/src/main.js');
    const scoped = await request(scope, '/@scope/x.js');

    // Then both come from the archive
    expect(await source?.text()).toBe('main()');
    expect(await scoped?.text()).toBe('x()');
  });

  it("As a dotli developer on the dev server, I load the sandbox's own modules and they reach the network", async () => {
    // Given a dev server worker whose archive ships the same module path
    const scope = startWorker(origin, true);
    await setArchive(scope, { 'index.html': '<html></html>', 'src/main.js': 'main()' });

    // When the module is asked for
    const source = await request(scope, '/src/main.js');

    // Then the worker leaves it to the network
    expect(source).toBeUndefined();
  });

  it("As a visitor on a deep link, I load the product's relative assets and they come from the archive root", async () => {
    // Given a product page written at a deep link, with its assets at the archive root
    const scope = startWorker(origin, false, { page: `${ORIGIN}/docs/intro` });
    await setArchive(scope, {
      'index.html': '<html></html>',
      'assets/app.js': 'app()',
      'assets/chunk.js': 'chunk()',
      'img/logo.svg': '<svg></svg>',
    });

    // When the page asks for its script, the script imports a sibling, and its CSS asks for an image one level up
    const script = await request(scope, '/docs/assets/app.js', 'no-cors', 'page');
    const chunk = await request(scope, '/docs/assets/chunk.js', 'no-cors', 'page');
    const image = await request(scope, '/docs/img/logo.svg', 'no-cors', 'page');

    // Then each comes from the archive, typed by its own name
    expect(await script?.text()).toBe('app()');
    expect(script?.headers.get('Content-Type')).toBe('application/javascript');
    expect(await chunk?.text()).toBe('chunk()');
    expect(await image?.text()).toBe('<svg></svg>');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a visitor on a deep link after the browser restarted the idle worker, I load a relative asset and it comes from the archive root', async () => {
    // Given a worker restarted over an archive the page handed to the one before it
    await setArchive(startWorker(origin), { 'index.html': '<html></html>', 'assets/app.js': 'app()' });
    const restarted = startWorker(origin, false, { page: `${ORIGIN}/docs/intro` });

    // When the page asks for its script
    const script = await request(restarted, '/docs/assets/app.js', 'no-cors', 'page');

    // Then the restarted worker serves it from the archive it read back
    expect(await script?.text()).toBe('app()');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a product that ships a file at the deep path itself, I request it from a deep link and get that file', async () => {
    // Given an archive holding both the deep path and the same name at the root
    const scope = startWorker(origin, false, { page: `${ORIGIN}/docs/intro` });
    await setArchive(scope, {
      'index.html': '<html></html>',
      'docs/assets/app.js': 'deep()',
      'assets/app.js': 'root()',
    });

    // When the page asks for the deep path
    const response = await request(scope, '/docs/assets/app.js', 'no-cors', 'page');

    // Then the exact path wins
    expect(await response?.text()).toBe('deep()');
  });

  it('As a product page at the root, I request a path the archive lacks and it reaches the network unchanged', async () => {
    // Given a page at the root, whose directory is the archive root itself
    const scope = startWorker(origin, false, { page: `${ORIGIN}/intro` });
    await setArchive(scope, { 'index.html': '<html></html>', 'assets/app.js': 'app()' });

    // When it asks for a path below a folder
    const response = await request(scope, '/docs/assets/app.js', 'no-cors', 'page');

    // Then the request goes to the network as it was
    expect(await response?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]?.[0]).toMatchObject({ url: `${ORIGIN}/docs/assets/app.js` });
  });

  it('As a visitor on a deep link, I navigate to a sub-path and the sandbox page loads from the network, never remapped', async () => {
    // Given a page at a deep link, and an archive holding the root file the sub-path would remap to
    const scope = startWorker(origin, false, { page: `${ORIGIN}/docs/intro` });
    await setArchive(scope, { 'index.html': '<html></html>', 'guide/index.html': '<p>guide</p>' });

    // When the browser navigates to the sub-path
    const response = await request(scope, '/docs/guide/', 'navigate', 'page');

    // Then the worker leaves it to the network
    expect(response).toBeUndefined();
  });

  it('As a visitor on a deep link, I request a path with a broken escape and it reaches the network', async () => {
    // Given a page at a deep link
    const scope = startWorker(origin, false, { page: `${ORIGIN}/docs/intro` });
    await setArchive(scope, { 'index.html': '<html></html>' });

    // When it asks for a path whose escape does not decode
    const response = await request(scope, '/docs/bad%E0%A4%A.js', 'no-cors', 'page');

    // Then the request goes to the network as it was
    expect(await response?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]?.[0]).toMatchObject({ url: `${ORIGIN}/docs/bad%E0%A4%A.js` });
  });
});
