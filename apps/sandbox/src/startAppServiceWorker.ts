// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the archive the page hands it. The iframe is credentialless, so this origin's storage lasts only as long as
// the host page.

/// <reference lib="webworker" />

import { createLazyLoad, isRecord } from '@dotli/shared';
import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import { APP_SERVICE_WORKER_NAME } from './appServiceWorkerName.js';
import { loadPersistedArchive, persistArchive } from './archiveDb.js';
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

/** A handoff as the worker reads it. Each field stays unchecked until it is read. */
type SetArchiveRequest = {
  type: typeof APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE;
  packed?: unknown;
  index?: unknown;
  directory?: unknown;
};

/** A page's message the worker acts on. */
type PageMessage =
  { type: Exclude<(typeof PAGE_MESSAGE_TYPES)[number], SetArchiveRequest['type']> } | SetArchiveRequest;

/** The worker's answer to a page's message. */
type WorkerReply =
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.VERSION; version: string }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR; reason: string };

const PAGE_MESSAGE_TYPES = [
  APP_SERVICE_WORKER_MESSAGES.CLAIM,
  APP_SERVICE_WORKER_MESSAGES.GET_VERSION,
  APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE,
] as const;

// The build the worker names when a page asks for its version. A build inlines it as a literal, so the worker's bytes
// change between releases and the browser never skips the update as byte-identical.
const WORKER_VERSION = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

/** Serves the archive the page hands it, from this scope's events. Each call is a fresh worker start. Never throws. */
export function startAppServiceWorker({
  scope,
  indexedDB,
  fetch: fetchFromNetwork,
  devServer,
}: StartAppServiceWorkerParams): void {
  const basePath = scope.location.pathname.replace(new RegExp(`(?:src/)?${APP_SERVICE_WORKER_NAME}\\.[jt]s$`), '');

  let served: ServedArchive | null = null;

  /** The read-back found nothing, so the page has not sent an archive yet. */
  let nothingPersisted = false;

  /**
   * The archive kept for restarts, read back by the first fetch that finds none in memory. A failed read is not kept,
   * so the next fetch reads it again, while only the first failure is reported to the page.
   */
  const restoreArchive = createLazyLoad({
    load: async (): Promise<void> => {
      const archive = await loadPersistedArchive(indexedDB);
      if (archive === null) {
        nothingPersisted = true;
        return;
      }
      // A SET_ARCHIVE that landed during the read is newer. The loader keeps nothing, so a later one frees the buffers.
      served ??= { files: unpackArchive(archive.packed, archive.index), directory: archive.directory ?? basePath };
    },
    onFirstMiss: error => {
      // Not awaited: the fetch waiting on this read-back must not wait on the report too.
      void scope.clients
        .matchAll({ type: 'window' })
        .then(clients => {
          reportArchiveFailure({ clients, stage: 'restore', error });
        })
        .catch((reportError: unknown) => {
          // eslint-disable-next-line no-console -- the worker has no logger, and this failure cannot reach a page
          console.error('Failed to report the archive restore failure to the pages:', reportError);
        });
    },
  });

  function hasArchive(): boolean {
    return served !== null;
  }

  function getFile(path: string): ArrayBuffer | undefined {
    return served !== null && Object.hasOwn(served.files, path) ? served.files[path] : undefined;
  }

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
   * Answers a request of this origin from the archive, after reading the archive back when a restart left none in
   * memory, and leaves any other request to the network.
   */
  function handleFetch(event: FetchEvent): void {
    const { request } = event;
    const url = new URL(request.url);
    if (url.origin !== scope.location.origin || isServedByNetwork(url, request)) {
      return;
    }

    if (hasArchive()) {
      const found = lookupServedFile(url.pathname);
      if (found !== null) {
        event.respondWith(found);
      }
      return;
    }

    if (nothingPersisted) {
      return;
    }

    // A restarted worker reads the archive back first, since nginx answers every path with the shell as `text/html`.
    event.respondWith(
      restoreArchive().then(
        () => {
          if (!hasArchive()) {
            return fetchFromNetwork(request);
          }
          return lookupServedFile(url.pathname) ?? fetchFromNetwork(request);
        },
        (error: unknown) => {
          // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
          console.error('Failed to restore the archive after a worker restart:', error);
          return fetchFromNetwork(request);
        },
      ),
    );
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

  /** Serves the handed archive at once and keeps it for a restart, answering the handoff either way. */
  function storeArchive(event: ExtendableMessageEvent, data: SetArchiveRequest): void {
    // An ACK without a payload would leave the sender looping forever against an empty SW.
    if (!hasArchivePayload(data)) {
      replyToPage(event, {
        type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR,
        reason: 'SET_ARCHIVE missing packed/index payload',
      });
      return;
    }
    const { packed, index, directory: sent } = data;

    // A page from the previous release names no directory, and its page needs no remap.
    const directory = typeof sent === 'string' ? sent : basePath;
    served = { files: unpackArchive(packed, index), directory };
    // The write matters only to the next instance, so it does not hold up the ACK. `waitUntil` keeps this one alive.
    event.waitUntil(
      persistArchive(indexedDB, { packed, index, directory }).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
        console.error('Failed to persist the archive; a restarted worker will not serve it:', error);
        const sender = getSender(event);
        if (sender !== null) {
          reportArchiveFailure({ clients: [sender], stage: 'persist', error });
        }
      }),
    );
    replyToPage(event, { type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY });
  }

  /** The archive's answer to `pathname` at its own path, or else under the page's directory. `null` when neither. */
  function lookupServedFile(pathname: string): Response | null {
    return lookupArchive(pathname) ?? lookupUnderPageDirectory(pathname);
  }

  /**
   * The archive file a request means once the page's directory is read as the archive root.
   *
   * The page is written at the URL the visitor opened, so below the root a relative URL resolves under the page's
   * directory, while the archive holds every file from its root. The directory is the one the page was written at, not
   * the requester's current URL: a product's router moves its page elsewhere, and a product's worker is open at its own
   * script's path, yet both still ask for files under the written directory.
   */
  function lookupUnderPageDirectory(pathname: string): Response | null {
    const directory = served?.directory ?? basePath;
    if (directory.length <= basePath.length || !directory.startsWith(basePath) || !pathname.startsWith(directory)) {
      return null;
    }
    return lookupArchive(basePath + pathname.slice(directory.length));
  }

  /**
   * `null` means the path is not the archive's and must reach the network: the origin also serves the shell's own
   * assets, and a 404 for them strands a refresh on the loader.
   */
  function lookupArchive(pathname: string): Response | null {
    const decoded = getArchivePath(pathname, basePath);
    if (decoded === null) {
      return null;
    }
    for (const filePath of listCandidatePaths(decoded)) {
      const content = getFile(filePath);
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

/** The page that sent a message, or `null` when no page did. */
function getSender(event: ExtendableMessageEvent): Client | null {
  // A page the worker controls sends as a `Client`. No `instanceof` check, since Node has no `Client` global.
  return event.source as Client | null;
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
