// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { packArchive } from '@dotli/content';
import { createDeferred, isRecord } from '@dotli/shared';

import { startAppServiceWorker, type StartAppServiceWorkerParams } from './startAppServiceWorker.js';

type WorkerScope = EventTarget;

/** The origin's storage and network, which outlive a worker across its restarts. */
type Origin = {
  indexedDB: IDBFactory;
  fetch: typeof fetch;
};

type StartWorkerParams = {
  /** Whether the worker runs on the dev server. */
  devServer?: boolean;
  /** Receives each message the worker posts to a page it controls. Throws what posting to that page throws. */
  postToPage?: (message: unknown) => void;
};

type PostFromPageParams = {
  /** The message's data. */
  data: unknown;
  /** The ports the message carries. */
  ports?: MessagePort[];
  /** Receives each message the worker posts to the sending page. Throws what posting to that page throws. */
  postToPage?: (message: unknown) => void;
};

/** The members of an IndexedDB transaction the archive store reads and sets. */
type FakeTransaction = {
  error: DOMException | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  objectStore: () => { put: () => object };
  abort: () => void;
};

/** The members of an IndexedDB open request the archive store reads and sets. */
type FakeOpenRequest = {
  result: { transaction: () => FakeTransaction; close: () => void };
  onsuccess: (() => void) | null;
};

const ORIGIN = 'https://coffer.app.dot.li';

/** Every message the worker posted to the pages it controls. */
let pageInbox: unknown[] = [];
const pageListeners = new Set<() => void>();

/** Resolves once the worker posts its next message to its pages. */
function waitForPageMessage(): Promise<void> {
  const posted = createDeferred<undefined>();
  function heard(): void {
    pageListeners.delete(heard);
    posted.resolve(undefined);
  }
  pageListeners.add(heard);
  return posted.promise;
}

/** Keeps `message` in the page inbox and tells every waiting listener. */
function postToInbox(message: unknown): void {
  pageInbox.push(message);
  for (const heard of [...pageListeners]) {
    heard();
  }
}

/** A fresh worker over the origin's existing storage. A second call is Chrome restarting a stopped idle worker. */
function startWorker(
  origin: Origin,
  { devServer = false, postToPage = postToInbox }: StartWorkerParams = {},
): WorkerScope {
  const scope = Object.assign(new EventTarget(), {
    location: new URL(`${ORIGIN}/app-sw.js`),
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([{ postMessage: postToPage }]),
    },
  });
  startAppServiceWorker({
    // The worker reads only these members of its scope and of its clients.
    scope: scope as unknown as StartAppServiceWorkerParams['scope'],
    ...origin,
    devServer,
  });
  return scope;
}

/**
 * Hands over an archive as the sandbox page does, and waits for every write the worker keeps alive. `directory` is
 * the directory of the path the page writes the product at. Resolves with what reached the page-wide channel.
 */
function setArchive(
  scope: WorkerScope,
  files: Record<string, string>,
  { directory = '/' }: { directory?: string } = {},
): Promise<unknown[]> {
  const encoder = new TextEncoder();
  const { packed, index } = packArchive(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)])),
  );
  return postFromPage(scope, { data: { type: 'SET_ARCHIVE', packed, index, directory } });
}

/**
 * Hands over an archive as the sandbox page does, on a port of its own that closes when the test ends, and keeps what
 * reached the page-wide channel.
 */
async function setArchiveOnPort(
  scope: WorkerScope,
  data: Record<string, unknown>,
  page: Pick<PostFromPageParams, 'postToPage'> = {},
): Promise<{ portReply: Promise<unknown>; pageReplies: unknown[] }> {
  const channel = new MessageChannel();
  onTestFinished(() => {
    channel.port1.close();
  });
  const portReply = createDeferred<unknown>();
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    portReply.resolve(event.data);
  };
  const pageReplies = await postFromPage(scope, { ...page, data, ports: [channel.port2] });
  return { portReply: portReply.promise, pageReplies };
}

/**
 * Posts `data` to the worker as a page it controls does, and waits for every write the worker keeps alive. Resolves
 * with what reached the page-wide channel, and rejects when a kept write rejects.
 */
async function postFromPage(
  scope: WorkerScope,
  { data, ports = [], postToPage }: PostFromPageParams,
): Promise<unknown[]> {
  const pageReplies: unknown[] = [];
  const kept: Promise<unknown>[] = [];
  const event = Object.assign(new Event('message'), {
    data,
    ports,
    source: {
      postMessage:
        postToPage ??
        ((message: unknown) => {
          pageReplies.push(message);
        }),
    },
    waitUntil: (promise: Promise<unknown>) => {
      kept.push(promise);
    },
  });
  scope.dispatchEvent(event);
  await Promise.all(kept);
  return pageReplies;
}

/** An IndexedDB that refuses to open, as a storage-starved or blocked origin's does. */
function createBrokenIndexedDb(): IDBFactory {
  // The archive store calls only `open`.
  return {
    open() {
      const request: { error: DOMException | null; onerror: (() => void) | null } = { error: null, onerror: null };
      setTimeout(() => {
        request.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        request.onerror?.();
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;
}

/** The origin's `storage`, whose first `failures` opens fail as a full quota does. */
function createFailingFirstIndexedDb(storage: IDBFactory, failures: number): IDBFactory {
  let left = failures;
  // The archive store calls only `open`.
  return {
    open(...args: Parameters<IDBFactory['open']>) {
      if (left > 0) {
        left -= 1;
        return createBrokenIndexedDb().open(...args);
      }
      return storage.open(...args);
    },
  } as unknown as IDBFactory;
}

/** An IndexedDB that opens, then aborts every write at commit, as a full quota does. Only `abort` fires. */
function createQuotaAbortingIndexedDb(): IDBFactory {
  const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  const transaction: FakeTransaction = {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore: () => ({ put: () => ({}) }),
    abort: () => undefined,
  };
  const db = {
    transaction() {
      setTimeout(() => {
        transaction.error = quota;
        transaction.onabort?.();
      }, 0);
      return transaction;
    },
    close: () => undefined,
  };
  // The archive store calls only `open`, and reads only these members of what it opens.
  return {
    open() {
      const request: FakeOpenRequest = { result: db, onsuccess: null };
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
  { mode = 'no-cors' }: { mode?: RequestMode } = {},
): Promise<Response | undefined> {
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

  it('As a user, I import a chunk after the browser restarted the idle worker and it still comes from the archive', async () => {
    // Given
    const first = startWorker(origin);
    const handedOver = await setArchive(first, { 'index.html': '<html></html>', '_nuxt/late.js': 'export default 1;' });

    // When
    const restarted = startWorker(origin);
    const response = await request(restarted, '/_nuxt/late.js');

    // Then
    expect(handedOver).toEqual([{ type: 'ARCHIVE_READY' }]);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('application/javascript');
    expect(await response?.text()).toBe('export default 1;');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a user, I reach a restarted worker and it serves the latest archive the page sent', async () => {
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

  it('As a user, I hand over a new archive after a restarted worker restored an older one and the new one is served', async () => {
    // Given a restarted worker that already served from the archive it read back
    await setArchive(startWorker(origin), { 'index.html': '<html></html>', 'old.js': 'old' });
    const restarted = startWorker(origin);
    await request(restarted, '/old.js');

    // When
    await setArchive(restarted, { 'index.html': '<html></html>', 'new.js': 'new' });
    const fresh = await request(restarted, '/new.js');
    const stale = await request(restarted, '/old.js');

    // Then
    expect(await fresh?.text()).toBe('new');
    expect(stale).toBeUndefined();
  });

  it('As a sandbox user, I hand over an archive with a reply port and only that port hears the acknowledgement', async () => {
    // Given
    const scope = startWorker(origin);
    const { packed, index } = packArchive({ 'index.html': new TextEncoder().encode('<html></html>') });

    // When
    const handoff = await setArchiveOnPort(scope, { type: 'SET_ARCHIVE', packed, index });

    // Then
    expect(handoff.pageReplies).toEqual([]);
    expect(await handoff.portReply).toEqual({ type: 'ARCHIVE_READY' });
  });

  it('As a sandbox user, I hand over an empty archive message and its port hears the refusal', async () => {
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
  });

  it('As a user, I open the sandbox page before any archive arrives and it still loads its own assets', async () => {
    // Given
    const scope = startWorker(origin);

    // When
    const shellAsset = await request(scope, '/assets/index.js');

    // Then
    expect(await shellAsset?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
  });

  it('As an operator, I hand over an archive the worker cannot keep for its next restart and the page hears why', async () => {
    // Given an origin whose storage refuses the write
    const scope = startWorker({ ...origin, indexedDB: createBrokenIndexedDb() });

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

  it('As an operator, I hand over an archive whose write the browser aborts at commit and the page hears why instead of the worker holding', async () => {
    // Given an origin whose storage aborts the write at commit
    const scope = startWorker({ ...origin, indexedDB: createQuotaAbortingIndexedDb() });

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

  it('As an operator, I hand over an archive the worker cannot keep, from a page that throws when the report reaches it, and the kept write still settles', async () => {
    // Given an origin whose storage refuses the write, and a page that throws when the report reaches it
    const scope = startWorker({ ...origin, indexedDB: createBrokenIndexedDb() });
    const { packed, index } = packArchive({ 'index.html': new TextEncoder().encode('<html></html>') });
    const reportRan = createDeferred<undefined>();
    function throwOnReport(): never {
      reportRan.resolve(undefined);
      throw new DOMException('The page is gone.', 'InvalidStateError');
    }

    // When the page hands over its archive on its own port, and the report has run and failed
    const handoff = setArchiveOnPort(scope, { type: 'SET_ARCHIVE', packed, index }, { postToPage: throwOnReport });
    await reportRan.promise;

    // Then the kept write settled, and the port still heard the acknowledgement
    await expect(handoff).resolves.toMatchObject({ pageReplies: [] });
    await expect(handoff.then(({ portReply }) => portReply)).resolves.toEqual({ type: 'ARCHIVE_READY' });
  });

  it('As an operator, I reach a restarted worker that cannot read the archive back and the page hears why', async () => {
    // Given a restarted worker over storage it cannot read
    const scope = startWorker({ ...origin, indexedDB: createBrokenIndexedDb() });
    const reported = waitForPageMessage();

    // When the app asks it for a file
    const response = await request(scope, '/main.js');
    await reported;

    // Then the request goes to the network, and the page hears why
    expect(await response?.text()).toBe('<!doctype html>shell');
    expect(pageInbox).toEqual([
      {
        type: 'ARCHIVE_FAILURE',
        stage: 'restore',
        name: 'QuotaExceededError',
        message: 'The quota has been exceeded.',
      },
    ]);
  });

  it('As an operator, I reach a restarted worker whose page throws when the report of a failed read-back reaches it and the request still reaches the network', async () => {
    // Given a restarted worker over storage it cannot read, whose page throws when the report reaches it
    const reportRan = createDeferred<undefined>();
    const scope = startWorker(
      { ...origin, indexedDB: createBrokenIndexedDb() },
      {
        postToPage() {
          reportRan.resolve(undefined);
          throw new DOMException('The page is gone.', 'InvalidStateError');
        },
      },
    );

    // When the app asks it for a file, and the report has run and failed
    const response = await request(scope, '/main.js');
    await reportRan.promise;

    // Then the request still went to the network
    expect(await response?.text()).toBe('<!doctype html>shell');
  });

  it('As a user, I ask again after a restarted worker failed its first read-back and it reads the archive back and serves it', async () => {
    // Given an archive kept in the origin's storage, and a restarted worker whose first read of it fails
    const first = startWorker(origin);
    await setArchive(first, { 'index.html': '<html></html>', '_nuxt/late.js': 'export default 1;' });
    const restarted = startWorker({ ...origin, indexedDB: createFailingFirstIndexedDb(origin.indexedDB, 1) });
    const reported = waitForPageMessage();
    const failed = await request(restarted, '/_nuxt/late.js');
    await reported;

    // When the app asks again
    const served = await request(restarted, '/_nuxt/late.js');

    // Then the first request went to the network, the second came from the archive, and the miss was reported once
    expect(await failed?.text()).toBe('<!doctype html>shell');
    expect(await served?.text()).toBe('export default 1;');
    expect(pageInbox.filter(message => isRecord(message) && message['stage'] === 'restore')).toHaveLength(1);
  });

  it('As a product developer, I fetch an HTML file from my archive and it comes back byte for byte', async () => {
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
    const response = await request(scope, '/docs/', { mode: 'navigate' });

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

  it('As a product developer, I fetch a file whose name holds an escaped space and it is served from my archive', async () => {
    // Given an archive holding a file with a space in its name
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'my file.js': 'spaced()' });

    // When the product asks for it escaped
    const response = await request(scope, '/my%20file.js');

    // Then the worker decodes the path and serves the file
    expect(await response?.text()).toBe('spaced()');
  });

  it('As a product developer who ships a src folder, I fetch its files and they come from my archive', async () => {
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
    const scope = startWorker(origin, { devServer: true });
    await setArchive(scope, { 'index.html': '<html></html>', 'src/main.js': 'main()' });

    // When the module is asked for
    const source = await request(scope, '/src/main.js');

    // Then the worker leaves it to the network
    expect(source).toBeUndefined();
  });

  it('As a visitor on a deep link whose product routed to another path, I load a lazy chunk and it comes from the archive root', async () => {
    // Given a product page written at /docs/intro, with its assets at the archive root
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'assets/x.js': 'x()' }, { directory: '/docs/' });

    // When the product has routed its page to /settings and its script imports a chunk beside itself
    const chunk = await request(scope, '/docs/assets/x.js');

    // Then the chunk comes from the archive, typed by its own name, with no network call
    expect(await chunk?.text()).toBe('x()');
    expect(chunk?.headers.get('Content-Type')).toBe('application/javascript');
    expect(network).not.toHaveBeenCalled();
  });

  it("As a product developer on a deep link, I import a module beside my dedicated worker's script and it comes from the archive's folder", async () => {
    // Given a product page written at /docs/intro, whose worker script is assets/worker.js
    const scope = startWorker(origin);
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'assets/worker.js': 'work()', 'assets/lib.js': 'lib()' },
      { directory: '/docs/' },
    );

    // When the worker, open at /docs/assets/worker.js, imports ./lib.js
    const lib = await request(scope, '/docs/assets/lib.js');

    // Then the module comes from the archive's assets folder, not its root
    expect(await lib?.text()).toBe('lib()');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a product developer who ships a file at the deep path itself, I request it from a deep link and get that file', async () => {
    // Given a page written at /docs/intro, and an archive holding both the deep path and the same name at the root
    const scope = startWorker(origin);
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'docs/assets/x.js': 'deep()', 'assets/x.js': 'root()' },
      { directory: '/docs/' },
    );

    // When the page asks for the deep path
    const response = await request(scope, '/docs/assets/x.js');

    // Then the exact path wins
    expect(await response?.text()).toBe('deep()');
  });

  it('As a visitor of a product written at the root, I request a path the archive lacks and the worker leaves it to the network', async () => {
    // Given a page written at /intro, whose directory is the archive root itself
    const scope = startWorker(origin);
    await setArchive(scope, { 'index.html': '<html></html>', 'assets/x.js': 'x()' }, { directory: '/' });

    // When it asks for a path below a folder
    const response = await request(scope, '/docs/assets/x.js');

    // Then the worker does not answer, so the request goes to the network as it was
    expect(response).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });

  it('As a visitor on a deep link after the browser restarted the idle worker, I load a relative asset and it comes from the archive root', async () => {
    // Given a worker restarted over an archive the page, written at /docs/intro, handed to the one before it
    await setArchive(
      startWorker(origin),
      { 'index.html': '<html></html>', 'assets/x.js': 'x()' },
      { directory: '/docs/' },
    );
    const restarted = startWorker(origin);

    // When the page asks for its chunk
    const chunk = await request(restarted, '/docs/assets/x.js');

    // Then the restarted worker serves it from the archive and the directory it read back
    expect(await chunk?.text()).toBe('x()');
    expect(network).not.toHaveBeenCalled();
  });

  it('As a visitor, I open the product at the root after a deep link and a restarted worker no longer remaps', async () => {
    // Given a page written at /docs/intro, then a later one written at the root, and a restart after both
    const first = startWorker(origin);
    await setArchive(first, { 'index.html': '<html></html>', 'assets/x.js': 'x()' }, { directory: '/docs/' });
    await setArchive(first, { 'index.html': '<html></html>', 'assets/x.js': 'x()' }, { directory: '/' });
    const restarted = startWorker(origin);

    // When the page asks for a path under the old deep link
    const response = await request(restarted, '/docs/assets/x.js');

    // Then the last handoff's directory holds, so the request goes to the network as it was
    expect(await response?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]?.[0]).toMatchObject({ url: `${ORIGIN}/docs/assets/x.js` });
  });

  it('As a visitor on a deep link, I navigate to a sub-path and the sandbox page loads from the network, never remapped', async () => {
    // Given a page written at /docs/intro, and an archive holding the root file the sub-path would remap to
    const scope = startWorker(origin);
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'guide/index.html': '<p>guide</p>' },
      { directory: '/docs/' },
    );

    // When the browser navigates to the sub-path
    const response = await request(scope, '/docs/guide/', { mode: 'navigate' });

    // Then the worker leaves it to the network
    expect(response).toBeUndefined();
  });

  it('As a visitor on a deep link, I request a path with a broken escape under it and it reaches the network', async () => {
    // Given a page written at /docs/intro, in a live worker and in one restarted over it
    const first = startWorker(origin);
    await setArchive(first, { 'index.html': '<html></html>' }, { directory: '/docs/' });
    const restarted = startWorker(origin);

    // When each is asked for a path under the deep link whose escape does not decode
    const live = await request(first, '/docs/bad%E0%A4%A.js');
    const afterRestart = await request(restarted, '/docs/bad%E0%A4%A.js');

    // Then the live worker lets it through, and the restarted one fetches it as it was
    expect(live).toBeUndefined();
    expect(await afterRestart?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]?.[0]).toMatchObject({ url: `${ORIGIN}/docs/bad%E0%A4%A.js` });
  });
});
