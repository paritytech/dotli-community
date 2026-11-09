// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves each page the archive it hands over. The iframe is credentialless, so this origin's storage lasts only as long
// as the host page.

/// <reference lib="webworker" />

import { createLazyLoad, isRecord } from '@dotli/shared';
import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import { APP_SERVICE_WORKER_NAME } from './appServiceWorkerName.js';
import {
  loadPersistedArchives,
  type PersistedArchive,
  type PersistedArchives,
  persistPageArchive,
  persistWorkerPage,
} from './archiveDb.js';
import { getArchivePath, hasExtension } from './getArchivePath.js';
import { getMimeType } from './getMimeType.js';
import type { SetArchiveMessage } from './handOverArchive.js';
import { reportArchiveFailure } from './reportArchiveFailure.js';
import { unpackArchive } from './unpackArchive.js';

/** What the worker needs from its global scope. */
export type StartAppServiceWorkerParams = {
  /** The worker's global scope, whose events drive it. */
  scope: Pick<ServiceWorkerGlobalScope, 'addEventListener' | 'clients' | 'location' | 'skipWaiting'>;
  /** The origin's storage, which outlives the worker across idle restarts. */
  indexedDB: IDBFactory;
  /** Fetches a request the archive does not answer. Rejects as the platform's `fetch` does. */
  fetch: typeof fetch;
  /** The dev server serves the sandbox's own modules under `src/`, `@` paths and `node_modules/`. */
  devServer: boolean;
};

/** The archive's files and the directory of the path its page is written at, replaced together by each handoff. */
type ServedArchive = {
  files: Record<string, ArrayBuffer>;
  directory: string;
};

/** The archives the worker serves, by the client each belongs to. */
type Archives = {
  /** Each page's own archive, by the id of the page's client. */
  byClient: Map<string, ServedArchive>;
  /** A worker a page started, by the worker client's id, to the id of that page's client. */
  workerPages: Map<string, string>;
  /** The archive handed last, for a client the worker cannot place. */
  newest: ServedArchive | null;
};

/** Whether the worker has read the store back since it started. */
type Restore = { readonly phase: 'unread' } | { readonly phase: 'read' };

/** A handoff as the worker reads it. Each field stays unchecked until it is read. */
type SetArchiveRequest = {
  type: typeof APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE;
  packed?: unknown;
  index?: unknown;
  directory?: unknown;
};

/** The types of a page's message the worker acts on. */
type PageMessageType =
  | typeof APP_SERVICE_WORKER_MESSAGES.CLAIM
  | typeof APP_SERVICE_WORKER_MESSAGES.GET_VERSION
  | typeof APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE;

/** A page's message the worker acts on. */
type PageMessage = { type: Exclude<PageMessageType, SetArchiveRequest['type']> } | SetArchiveRequest;

/** The worker's answer to a page's message. */
type WorkerReply =
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.VERSION; version: string }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR; reason: string };

const PAGE_MESSAGE_TYPES: readonly PageMessageType[] = [
  APP_SERVICE_WORKER_MESSAGES.CLAIM,
  APP_SERVICE_WORKER_MESSAGES.GET_VERSION,
  APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE,
];

// The build the worker names when a page asks for its version. A build inlines it as a literal, so the worker's bytes
// change between releases and the browser never skips the update as byte-identical.
const WORKER_VERSION = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

/**
 * Serves each page the archive it hands over, from this scope's events. Each call is a fresh worker start. Never
 * throws.
 */
export function startAppServiceWorker({
  scope,
  indexedDB,
  fetch: fetchFromNetwork,
  devServer,
}: StartAppServiceWorkerParams): void {
  const basePath = scope.location.pathname.replace(new RegExp(`(?:src/)?${APP_SERVICE_WORKER_NAME}\\.[jt]s$`), '');

  const archives: Archives = { byClient: new Map(), workerPages: new Map(), newest: null };

  let restore: Restore = { phase: 'unread' };

  /**
   * The archives kept for restarts, read back by the first fetch whose client has none in memory. A failed read is not
   * kept, so the next such fetch reads them again, while only the first failure is reported to the pages.
   */
  const restoreArchive = createLazyLoad({
    load: async (): Promise<void> => {
      keepRestored(await loadPersistedArchives(indexedDB));
      restore = { phase: 'read' };
    },
    onFirstMiss: error => {
      // Not awaited: the fetch waiting on this read-back must not wait on the report too.
      void reportToPages({ stage: 'restore', error });
    },
  });

  scope.addEventListener('install', () => {
    void scope.skipWaiting();
  });

  scope.addEventListener('activate', event => {
    event.waitUntil(scope.clients.claim());
  });

  scope.addEventListener('message', handleMessage);

  scope.addEventListener('fetch', handleFetch);

  /** Acts on a page's message by its type, and ignores a message of any other type. */
  function handleMessage(event: ExtendableMessageEvent): void {
    const data: unknown = event.data;
    if (!isPageMessage(data)) {
      return;
    }
    switch (data.type) {
      case APP_SERVICE_WORKER_MESSAGES.CLAIM:
        void scope.clients.claim();
        return;
      case APP_SERVICE_WORKER_MESSAGES.GET_VERSION:
        replyToPage(event, { type: APP_SERVICE_WORKER_MESSAGES.VERSION, version: WORKER_VERSION });
        return;
      case APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE:
        storeArchive(event, data);
        return;
    }
  }

  /**
   * Answers a request of this origin from its client's archive, after reading the archives back when a restart may have
   * left that archive in the store only, and leaves any other request to the network.
   */
  function handleFetch(event: FetchEvent): void {
    const { request } = event;
    const url = new URL(request.url);
    if (url.origin !== scope.location.origin || isServedByNetwork(url, request)) {
      return;
    }
    linkWorkerPage(event);

    const own = getClientArchive(event.clientId);
    if (own === null && restore.phase === 'unread') {
      // A restarted worker reads the archives back first, since nginx answers every path with the shell as `text/html`.
      event.respondWith(answerAfterRestore(event, url.pathname));
      return;
    }
    const archive = own ?? archives.newest;
    const found = archive === null ? null : lookupServedFile(archive, url.pathname);
    if (found !== null) {
      event.respondWith(found);
    }
  }

  /** Reads the archives back, then answers from the client's archive or the newest, and else from the network. */
  async function answerAfterRestore({ request, clientId }: FetchEvent, pathname: string): Promise<Response> {
    try {
      await restoreArchive();
    } catch (error: unknown) {
      // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
      console.error('Failed to restore the archives after a worker restart:', error);
    }
    const archive = getClientArchive(clientId) ?? archives.newest;
    return (archive === null ? null : lookupServedFile(archive, pathname)) ?? fetchFromNetwork(request);
  }

  /** The client's own archive, else the archive of the page that started it. `null` when memory holds neither. */
  function getClientArchive(clientId: string): ServedArchive | null {
    const own = archives.byClient.get(clientId);
    if (own !== undefined) {
      return own;
    }
    const pageId = archives.workerPages.get(clientId);
    return pageId === undefined ? null : (archives.byClient.get(pageId) ?? null);
  }

  /**
   * Fills in what the store kept only where memory has nothing, since a handoff that landed during the read is newer.
   * The newest is the page's own entry, so each record's buffers are unpacked once.
   */
  function keepRestored({ pages, workerPages, newest }: PersistedArchives): void {
    for (const [clientId, record] of pages) {
      if (!archives.byClient.has(clientId)) {
        archives.byClient.set(clientId, {
          files: unpackArchive(record.packed, record.index),
          directory: record.directory,
        });
      }
    }
    for (const [workerId, pageId] of workerPages) {
      if (!archives.workerPages.has(workerId)) {
        archives.workerPages.set(workerId, pageId);
      }
    }
    if (newest !== null) {
      archives.newest ??= archives.byClient.get(newest) ?? null;
    }
  }

  /**
   * Records the page that starts a product's worker, so the worker's requests are answered from that page's archive.
   * The browser names the worker's client on its script request only.
   */
  function linkWorkerPage(event: FetchEvent): void {
    const { request, clientId: pageId, resultingClientId: workerId } = event;
    if (!isWorkerScript(request) || pageId === '' || workerId === '') {
      return;
    }
    archives.workerPages.set(workerId, pageId);
    event.waitUntil(
      persistWorkerPage(indexedDB, { workerId, pageId }).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
        console.error("Failed to persist a worker's page; a restarted worker will serve it the newest archive:", error);
        return reportToPages({ stage: 'persist', error });
      }),
    );
  }

  /** Tells every page of a failure no single page caused. Never rejects: a report that fails is logged. */
  function reportToPages({ stage, error }: Omit<Parameters<typeof reportArchiveFailure>[0], 'clients'>): Promise<void> {
    return scope.clients
      .matchAll({ type: 'window' })
      .then(clients => {
        reportArchiveFailure({ clients, stage, error });
      })
      .catch((reportError: unknown) => {
        // eslint-disable-next-line no-console -- the worker has no logger, and this failure cannot reach a page
        console.error('Failed to report the archive failure to the pages:', reportError);
      });
  }

  /**
   * The sandbox page and this worker come from the network. So does every navigation, since the page writes the
   * product's index.html into its own window. On the dev server the sandbox's own modules do too.
   */
  function isServedByNetwork(url: URL, request: Request): boolean {
    return (
      request.mode === 'navigate' ||
      url.pathname === basePath ||
      url.pathname === basePath.slice(0, -1) ||
      url.pathname === `${basePath}${APP_SERVICE_WORKER_NAME}.js` ||
      (devServer &&
        (url.pathname.startsWith(`${basePath}src/`) ||
          url.pathname.startsWith(`${basePath}node_modules/`) ||
          url.pathname.startsWith(`${basePath}@`)))
    );
  }

  /** Serves the handed archive to its page at once and keeps it for a restart, answering the handoff either way. */
  function storeArchive(event: ExtendableMessageEvent, data: SetArchiveRequest): void {
    // An ACK without a payload would leave the sender looping forever against an empty SW.
    if (!hasArchivePayload(data)) {
      replyToPage(event, {
        type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR,
        reason: 'SET_ARCHIVE missing packed/index payload',
      });
      return;
    }
    // The archive is kept under its page's client, so a handoff from no page has nowhere to go.
    const sender = getSender(event);
    if (sender === null) {
      replyToPage(event, { type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR, reason: 'SET_ARCHIVE from no page' });
      return;
    }
    const { packed, index, directory: sent } = data;

    // A page from the previous release names no directory, and its page needs no remap.
    const directory = typeof sent === 'string' ? sent : basePath;
    const archive = { files: unpackArchive(packed, index), directory };
    archives.byClient.set(sender.id, archive);
    archives.newest = archive;
    // The write matters only to the next instance, so it does not hold up the ACK. `waitUntil` keeps this one alive.
    event.waitUntil(
      keepPageArchive(sender.id, { packed, index, directory }).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
        console.error('Failed to persist the archive; a restarted worker will not serve it:', error);
        reportArchiveFailure({ clients: [sender], stage: 'persist', error });
      }),
    );
    replyToPage(event, { type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY });
  }

  /** Forgets the clients no longer open and keeps a page's archive for a restart. Rejects as the store does. */
  async function keepPageArchive(clientId: string, archive: PersistedArchive): Promise<void> {
    const clients = await scope.clients.matchAll({ includeUncontrolled: true, type: 'all' });
    const liveClientIds = new Set(clients.map(client => client.id));
    dropClosedClients(clientId, liveClientIds);
    await persistPageArchive(indexedDB, { clientId, archive, liveClientIds });
  }

  /** Drops the archives and links of clients that are not open, except the sender's, which was open to send. */
  function dropClosedClients(senderId: string, liveClientIds: ReadonlySet<string>): void {
    for (const clientId of archives.byClient.keys()) {
      if (clientId !== senderId && !liveClientIds.has(clientId)) {
        archives.byClient.delete(clientId);
      }
    }
    for (const workerId of archives.workerPages.keys()) {
      if (workerId !== senderId && !liveClientIds.has(workerId)) {
        archives.workerPages.delete(workerId);
      }
    }
  }

  /** The archive's answer to `pathname` at its own path, or else under the page's directory. `null` when neither. */
  function lookupServedFile(archive: ServedArchive, pathname: string): Response | null {
    return lookupArchive(archive, pathname) ?? lookupUnderPageDirectory(archive, pathname);
  }

  /**
   * The archive file a request means once the page's directory is read as the archive root.
   *
   * The page is written at the URL the visitor opened, so below the root a relative URL resolves under the page's
   * directory, while the archive holds every file from its root. The directory is the one the page was written at, not
   * the requester's current URL: a product's router moves its page elsewhere, and a product's worker is open at its own
   * script's path, yet both still ask for files under the written directory.
   */
  function lookupUnderPageDirectory(archive: ServedArchive, pathname: string): Response | null {
    const { directory } = archive;
    if (directory.length <= basePath.length || !directory.startsWith(basePath) || !pathname.startsWith(directory)) {
      return null;
    }
    return lookupArchive(archive, basePath + pathname.slice(directory.length));
  }

  /**
   * `null` means the path is not the archive's and must reach the network: the origin also serves the shell's own
   * assets, and a 404 for them strands a refresh on the loader.
   */
  function lookupArchive({ files }: ServedArchive, pathname: string): Response | null {
    const decoded = getArchivePath(pathname, basePath);
    if (decoded === null) {
      return null;
    }
    for (const filePath of listCandidatePaths(decoded)) {
      const content = Object.hasOwn(files, filePath) ? files[filePath] : undefined;
      if (content !== undefined) {
        return new Response(content, createArchiveResponseInit(getMimeType(filePath)));
      }
    }
    return null;
  }
}

/** Whether a page's message has a type the worker acts on. */
function isPageMessage(data: unknown): data is PageMessage {
  return isRecord(data) && PAGE_MESSAGE_TYPES.some(type => type === data['type']);
}

/**
 * Answers a page's message on the port it sent, so a late answer cannot settle a later request and no global listener
 * is needed. A page from the previous release sends no port and hears the answer as a message to its page. Throws what
 * posting throws.
 */
function replyToPage(event: ExtendableMessageEvent, message: WorkerReply): void {
  const [port] = event.ports;
  if (port !== undefined) {
    port.postMessage(message);
    return;
  }
  getSender(event)?.postMessage(message);
}

/** The page that sent a message, or `null` when no client did. */
function getSender({ source }: ExtendableMessageEvent): Client | null {
  // A page the worker controls sends as a `Client`, the one source with an id. No `instanceof` check, since Node has
  // no `Client` global.
  return source !== null && 'id' in source ? source : null;
}

/** Whether a request fetches the script of a product's worker. */
function isWorkerScript(request: Request): boolean {
  return request.destination === 'worker' || request.destination === 'sharedworker';
}

/** Whether a `SET_ARCHIVE` message carries the packed archive and its index. */
function hasArchivePayload(
  data: SetArchiveRequest,
): data is SetArchiveRequest & Pick<SetArchiveMessage, 'packed' | 'index'> {
  return data.packed instanceof ArrayBuffer && Array.isArray(data.index);
}

/**
 * The archive paths a request for `decoded` may mean, in the order they are tried: the path itself, then, without an
 * extension, its `index.html` below it and beside it, then the root `index.html` for the root itself.
 */
function listCandidatePaths(decoded: string): string[] {
  const candidates = [decoded];
  if (!hasExtension(decoded)) {
    candidates.push(decoded === '' ? 'index.html' : `${decoded}/index.html`);
    if (decoded !== '') {
      candidates.push(`${decoded}index.html`);
    }
  }
  if (decoded === '' || decoded === '/') {
    candidates.push('index.html');
  }
  return candidates;
}

/** One source, so a new header lands on every served body. */
function createArchiveResponseInit(mime: string): ResponseInit {
  return {
    status: 200,
    headers: {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  };
}
