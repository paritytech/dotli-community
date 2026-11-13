// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { packArchive } from '@dotli/content';
import { createDeferred, isRecord } from '@dotli/shared';

import { loadPersistedArchives } from './archiveDb.js';
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
  /** The ids of the clients open on the worker's origin. */
  liveClients?: string[];
  /** Holds each client listing, in order, until its promise settles. A listing past the last one is not held. */
  holdListings?: Promise<undefined>[];
};

type PostFromPageParams = {
  /** The message's data. */
  data: unknown;
  /** The ports the message carries. */
  ports?: MessagePort[];
  /** Receives each message the worker posts to the sending page. Throws what posting to that page throws. */
  postToPage?: (message: unknown) => void;
  /** The id of the sending page's client. */
  clientId?: string;
  /** `null` sends the message from no page. */
  source?: null;
};

type SetArchiveParams = {
  /** The directory of the path the page writes the product at. */
  directory?: string;
  /** The id of the sending page's client. */
  clientId?: string;
};

type RequestParams = {
  mode?: RequestMode;
  /** The id of the client the request comes from. */
  clientId?: string;
  destination?: RequestDestination;
  /** The id of the client a worker script request starts, or empty when the browser names none. */
  resultingClientId?: string;
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
  { devServer = false, liveClients = ['page-1'], holdListings = [] }: StartWorkerParams = {},
): WorkerScope {
  let listings = 0;
  const scope = Object.assign(new EventTarget(), {
    location: new URL(`${ORIGIN}/app-sw.js`),
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => {
        await holdListings[listings++];
        return liveClients.map(id => ({ id, postMessage: postToInbox }));
      },
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
  { directory = '/', clientId = 'page-1' }: SetArchiveParams = {},
): Promise<unknown[]> {
  const encoder = new TextEncoder();
  const { packed, index } = packArchive(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)])),
  );
  return postFromPage(scope, { data: { type: 'SET_ARCHIVE', packed, index, directory }, clientId });
}

/**
 * Hands over an archive as the sandbox page does, on a port of its own that closes when the test ends, and keeps what
 * reached the page-wide channel.
 */
async function setArchiveOnPort(
  scope: WorkerScope,
  data: Record<string, unknown>,
  page: Pick<PostFromPageParams, 'postToPage' | 'source'> = {},
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
  { data, ports = [], postToPage, clientId = 'page-1', source }: PostFromPageParams,
): Promise<unknown[]> {
  const pageReplies: unknown[] = [];
  const kept: Promise<unknown>[] = [];
  const event = Object.assign(new Event('message'), {
    data,
    ports,
    source:
      source === null
        ? null
        : {
            id: clientId,
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

/**
 * `undefined` means the worker let the request through to the network. Resolves once every write the worker keeps
 * alive settled too.
 */
async function request(
  scope: WorkerScope,
  path: string,
  { mode = 'no-cors', clientId = 'page-1', destination = '', resultingClientId = '' }: RequestParams = {},
): Promise<Response | undefined> {
  let answer: Response | Promise<Response> | undefined;
  const kept: Promise<unknown>[] = [];
  const event = Object.assign(new Event('fetch'), {
    request: { url: `${ORIGIN}${path}`, mode, destination },
    clientId,
    resultingClientId,
    respondWith: (response: Response | Promise<Response>) => {
      answer = response;
    },
    waitUntil: (promise: Promise<unknown>) => {
      kept.push(promise);
    },
  });
  scope.dispatchEvent(event);
  const response = answer === undefined ? undefined : await answer;
  await Promise.all(kept);
  return response;
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

  it('As a visitor with two tabs open, I load a chunk in each while a restarted worker fails its read-back and both go to the network, reported once', async () => {
    // Given two tabs that each handed over their own archive, and a restarted worker whose first read fails
    const first = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'first()' }, { clientId: 'page-1' });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'second()' }, { clientId: 'page-2' });
    const restarted = startWorker(
      { ...origin, indexedDB: createFailingFirstIndexedDb(origin.indexedDB, 1) },
      { liveClients: ['page-1', 'page-2'] },
    );
    const reported = waitForPageMessage();

    // When both tabs load their chunk before the read-back ends
    const [firstChunk, secondChunk] = await Promise.all([
      request(restarted, '/late.js', { clientId: 'page-1' }),
      request(restarted, '/late.js', { clientId: 'page-2' }),
    ]);
    await reported;

    // Then both were answered from the network, and each of the two pages heard of the miss once
    expect(await firstChunk?.text()).toBe('<!doctype html>shell');
    expect(await secondChunk?.text()).toBe('<!doctype html>shell');
    expect(pageInbox.filter(message => isRecord(message) && message['stage'] === 'restore')).toHaveLength(2);
  });

  it('As a visitor with two tabs open, I load a chunk in each while a restarted worker reads the archives back and one read serves both', async () => {
    // Given two tabs that each handed over their own archive to a worker the browser then stopped, over storage that
    // counts its reads
    const first = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'first()' }, { clientId: 'page-1' });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'second()' }, { clientId: 'page-2' });
    let opens = 0;
    // The archive store calls only `open`.
    const counted = {
      open(...args: Parameters<IDBFactory['open']>) {
        opens += 1;
        return origin.indexedDB.open(...args);
      },
    } as unknown as IDBFactory;
    const restarted = startWorker({ ...origin, indexedDB: counted }, { liveClients: ['page-1', 'page-2'] });

    // When both tabs load their chunk before the read-back ends
    const [firstChunk, secondChunk] = await Promise.all([
      request(restarted, '/late.js', { clientId: 'page-1' }),
      request(restarted, '/late.js', { clientId: 'page-2' }),
    ]);

    // Then each comes from its own archive, after one read of the store
    expect(await firstChunk?.text()).toBe('first()');
    expect(await secondChunk?.text()).toBe('second()');
    expect(opens).toBe(1);
    expect(network).not.toHaveBeenCalled();
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

  it('As a visitor with the same product open in two tabs, I load a lazy chunk in the first after the second handed over its archive and it comes from my own', async () => {
    // Given two tabs of one product, each with its own build of the chunk
    const scope = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(scope, { 'index.html': '<html></html>', 'late.js': 'first()' }, { clientId: 'page-1' });
    await setArchive(scope, { 'index.html': '<html></html>', 'late.js': 'second()' }, { clientId: 'page-2' });

    // When the first tab loads its chunk
    const chunk = await request(scope, '/late.js', { clientId: 'page-1' });

    // Then it comes from the first tab's archive
    expect(await chunk?.text()).toBe('first()');
  });

  it('As a visitor with the same product open on two deep links, I load a relative asset in each and it resolves under my own directory', async () => {
    // Given one tab written at /docs/intro and another at /guide/intro
    const scope = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'assets/x.js': 'docs()' },
      { directory: '/docs/', clientId: 'page-1' },
    );
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'assets/x.js': 'guide()' },
      { directory: '/guide/', clientId: 'page-2' },
    );

    // When each tab loads the asset beside its page
    const docs = await request(scope, '/docs/assets/x.js', { clientId: 'page-1' });
    const guide = await request(scope, '/guide/assets/x.js', { clientId: 'page-2' });

    // Then each comes from its own archive, under its own directory
    expect(await docs?.text()).toBe('docs()');
    expect(await guide?.text()).toBe('guide()');
    expect(network).not.toHaveBeenCalled();
  });

  it("As a product developer, I import a module in my dedicated worker after another tab handed over its archive and it comes from my page's archive", async () => {
    // Given two tabs, the second of which handed over its archive last
    const scope = startWorker(origin, { liveClients: ['page-1', 'page-2', 'worker-1'] });
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'assets/worker.js': 'work(1)', 'assets/lib.js': 'lib(1)' },
      { clientId: 'page-1' },
    );
    await setArchive(
      scope,
      { 'index.html': '<html></html>', 'assets/worker.js': 'work(2)', 'assets/lib.js': 'lib(2)' },
      { clientId: 'page-2' },
    );

    // When the first tab's product starts its dedicated worker and the worker imports its module
    const script = await request(scope, '/assets/worker.js', {
      clientId: 'page-1',
      destination: 'worker',
      resultingClientId: 'worker-1',
    });
    const lib = await request(scope, '/assets/lib.js', { clientId: 'worker-1' });

    // Then the script and the module come from the page that started the worker
    expect(await script?.text()).toBe('work(1)');
    expect(await lib?.text()).toBe('lib(1)');
  });

  it('As a product developer whose browser names no worker client, I import a module in my worker and it comes from the newest archive', async () => {
    // Given a page that started a worker the browser named no client for, and another tab that handed over after
    const scope = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(scope, { 'index.html': '<html></html>', 'assets/lib.js': 'lib(1)' }, { clientId: 'page-1' });
    await request(scope, '/assets/worker.js', { clientId: 'page-1', destination: 'worker' });
    await setArchive(scope, { 'index.html': '<html></html>', 'assets/lib.js': 'lib(2)' }, { clientId: 'page-2' });

    // When the worker imports its module
    const lib = await request(scope, '/assets/lib.js', { clientId: 'worker-1' });

    // Then it comes from the archive handed last
    expect(await lib?.text()).toBe('lib(2)');
  });

  it('As a visitor with two tabs open, I reach a restarted worker and each tab is served from its own archive', async () => {
    // Given two tabs that each handed over their own archive to a worker the browser then stopped
    const first = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'first()' }, { clientId: 'page-1' });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'second()' }, { clientId: 'page-2' });

    // When each tab loads its chunk from the restarted worker
    const restarted = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    const firstChunk = await request(restarted, '/late.js', { clientId: 'page-1' });
    const secondChunk = await request(restarted, '/late.js', { clientId: 'page-2' });

    // Then each comes from its own archive
    expect(await firstChunk?.text()).toBe('first()');
    expect(await secondChunk?.text()).toBe('second()');
  });

  it("As a visitor who closed a tab, I hand over an archive in another and the closed tab's archive is dropped", async () => {
    // Given a tab that handed over an archive and was then closed
    const both = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(both, { 'index.html': '<html></html>', 'gone.js': 'gone()' }, { clientId: 'page-2' });
    const one = startWorker(origin, { liveClients: ['page-1'] });

    // When the tab still open hands over its own, and a restarted worker is asked for the closed tab's file
    await setArchive(one, { 'index.html': '<html></html>' }, { clientId: 'page-1' });
    const persisted = await loadPersistedArchives(origin.indexedDB);
    const gone = await request(startWorker(origin), '/gone.js', { clientId: 'page-2' });

    // Then the store keeps only the open tab's archive, and the closed tab's file reaches the network
    expect([...persisted.pages.keys()]).toEqual(['page-1']);
    expect(await gone?.text()).toBe('<!doctype html>shell');
    expect(network).toHaveBeenCalledOnce();
  });

  it('As an operator, I hand over an archive from no page and the port hears the refusal', async () => {
    // Given a worker and a whole archive
    const scope = startWorker(origin);
    const { packed, index } = packArchive({ 'index.html': new TextEncoder().encode('<html></html>') });

    // When the archive is handed over on a port from no page
    const handoff = await setArchiveOnPort(scope, { type: 'SET_ARCHIVE', packed, index }, { source: null });

    // Then the port hears the refusal
    expect(await handoff.portReply).toEqual({ type: 'ARCHIVE_ERROR', reason: 'SET_ARCHIVE from no page' });
  });

  it("As a visitor with two tabs open, I load a chunk in one after a restarted worker heard the other's handoff and it comes from my own archive", async () => {
    // Given two tabs that each handed over their own archive, and a restarted worker that heard only the second again
    const first = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'first()' }, { clientId: 'page-1' });
    await setArchive(first, { 'index.html': '<html></html>', 'late.js': 'second()' }, { clientId: 'page-2' });
    const restarted = startWorker(origin, { liveClients: ['page-1', 'page-2'] });
    await setArchive(restarted, { 'index.html': '<html></html>', 'late.js': 'second()' }, { clientId: 'page-2' });

    // When the first tab loads its chunk
    const chunk = await request(restarted, '/late.js', { clientId: 'page-1' });

    // Then it comes from the first tab's archive, read back from the store
    expect(await chunk?.text()).toBe('first()');
  });

  it("As an operator, I start a product's worker whose link to its page the worker cannot keep and the pages hear why", async () => {
    // Given a page that handed over its archive to a worker over storage that refuses every write
    const scope = startWorker({ ...origin, indexedDB: createBrokenIndexedDb() });
    await setArchive(scope, { 'index.html': '<html></html>', 'assets/worker.js': 'work()' }, { clientId: 'page-1' });

    // When the product starts its worker
    const script = await request(scope, '/assets/worker.js', {
      clientId: 'page-1',
      destination: 'worker',
      resultingClientId: 'worker-1',
    });

    // Then the script still comes from the page's archive, and the pages hear why a restart would lose the link
    expect(await script?.text()).toBe('work()');
    expect(pageInbox).toEqual([
      {
        type: 'ARCHIVE_FAILURE',
        stage: 'persist',
        name: 'QuotaExceededError',
        message: 'The quota has been exceeded.',
      },
    ]);
  });

  it('As a visitor with two tabs open, I hand over in both and a restarted worker serves a client it cannot place the archive handed last', async () => {
    // Given the first tab's handoff held back while the second tab's goes through
    const firstListing = createDeferred<undefined>();
    const scope = startWorker(origin, { liveClients: ['page-1', 'page-2'], holdListings: [firstListing.promise] });
    const firstHandoff = setArchive(
      scope,
      { 'index.html': '<html></html>', 'late.js': 'first()' },
      { clientId: 'page-1' },
    );
    const secondHandoff = setArchive(
      scope,
      { 'index.html': '<html></html>', 'late.js': 'second()' },
      { clientId: 'page-2' },
    );

    // When the held handoff goes on after the later one, and a restarted worker is asked by a client it does not know
    firstListing.resolve(undefined);
    await Promise.all([firstHandoff, secondHandoff]);
    const chunk = await request(startWorker(origin), '/late.js', { clientId: 'unknown' });

    // Then it comes from the archive handed over last
    expect(await chunk?.text()).toBe('second()');
  });

  it('As a visitor, I open two tabs that hand over their archives while the worker lists the open pages for an earlier handoff, and each tab is served its own', async () => {
    // Given a worker whose listings of the open pages are held, and the first tab's handoff waiting on the first one
    const listings = [createDeferred<undefined>(), createDeferred<undefined>(), createDeferred<undefined>()];
    onTestFinished(() => {
      for (const listing of listings) {
        listing.resolve(undefined);
      }
    });
    const liveClients = ['page-1'];
    const scope = startWorker(origin, { liveClients, holdListings: listings.map(listing => listing.promise) });
    const firstHandoff = setArchive(scope, { 'late.js': 'first()' }, { clientId: 'page-1' });
    void setArchive(scope, { 'late.js': 'second()' }, { clientId: 'page-2' });
    void setArchive(scope, { 'late.js': 'third()' }, { clientId: 'page-3' });

    // When the listing taken before the two tabs opened ends, and the second tab loads a chunk
    listings[0]?.resolve(undefined);
    await firstHandoff;
    liveClients.push('page-2', 'page-3');
    const chunk = await request(scope, '/late.js', { clientId: 'page-2' });

    // Then
    expect(await chunk?.text()).toBe('second()');
  });

  it('As a user, I start a product worker while the worker lists the open pages for a handoff, and after a restart the product worker is still served the archive of the page that started it', async () => {
    // Given the page's handoff waiting on a listing of the open clients taken before the product worker started
    const listing = createDeferred<undefined>();
    onTestFinished(() => {
      listing.resolve(undefined);
    });
    const liveClients = ['page-1'];
    const first = startWorker(origin, { liveClients, holdListings: [listing.promise] });
    const handoff = setArchive(first, { 'late.js': 'first()' }, { clientId: 'page-1' });
    const workerScript = request(first, '/worker.js', {
      clientId: 'page-1',
      destination: 'worker',
      resultingClientId: 'worker-1',
    });

    // When the listing ends, another tab hands over the newest archive, and a restarted worker is asked by the
    // product worker
    listing.resolve(undefined);
    await handoff;
    liveClients.push('worker-1', 'page-2');
    await workerScript;
    await setArchive(first, { 'late.js': 'second()' }, { clientId: 'page-2' });
    const chunk = await request(startWorker(origin, { liveClients }), '/late.js', { clientId: 'worker-1' });

    // Then
    expect(await chunk?.text()).toBe('first()');
  });
  it('As an operator, I watch the browser refuse an answer the worker gives a fetch and the pages hear it as a failure to serve', async () => {
    // Given a worker serving a page's archive
    const scope = startWorker(origin);
    await setArchive(scope, { 'late.js': 'first()' });
    const reported = waitForPageMessage();
    const fetchEvent = Object.assign(new Event('fetch'), {
      request: { url: `${ORIGIN}/late.js`, mode: 'no-cors', destination: '' },
      clientId: 'page-1',
      resultingClientId: '',
      respondWith: () => {
        throw new DOMException('The fetch event has already been responded to.', 'InvalidStateError');
      },
      waitUntil: () => undefined,
    });

    // When the page loads a chunk
    scope.dispatchEvent(fetchEvent);
    await reported;

    // Then
    expect(pageInbox).toEqual([
      {
        type: 'ARCHIVE_FAILURE',
        stage: 'serve',
        name: 'InvalidStateError',
        message: 'The fetch event has already been responded to.',
      },
    ]);
  });
});
