// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the archive the page hands it. The iframe is credentialless, so this origin's storage lasts only as long as
// the host page, and the host keeps the content blocks instead.

/// <reference lib="webworker" />

import { createLazyLoad, errorMessage, errorName, idbRequest, idbTransaction, openIdb } from '@dotli/shared';
import type { SetArchiveMessage } from './archive-handoff.js';
import { getMimeType } from './mime.js';

// The page reads it through `GET_SW_VERSION` to detect a stale worker. A build inlines it as a literal, so the worker's
// bytes change between releases and the browser never skips the update as byte-identical.
const SW_VERSION = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  return lastDot > lastSlash;
}

/** The archive path a request names, or null when its escapes do not decode, so it names no archive file. */
function archivePath(pathname: string, base: string): string | null {
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.slice(1);
  try {
    return decodeURIComponent(relative);
  } catch (err) {
    if (err instanceof URIError) {
      return null;
    }
    throw err;
  }
}

// The browser stops an idle worker after about 30s, so the archive is also kept in IndexedDB and read back on the
// first fetch after a restart.

type ArchiveIndex = { p: string; o: number; l: number }[];

interface PersistedArchive {
  packed: ArrayBuffer;
  index: ArchiveIndex;
  /** Absent in an archive a worker from the previous release kept. */
  directory?: string;
}

/** The archive's files and the directory of the path its page is written at, replaced together by each handoff. */
interface ServedArchive {
  files: Record<string, ArrayBuffer>;
  directory: string;
}

const ARCHIVE_DB_NAME = 'dotli-app-sw';
const ARCHIVE_STORE = 'archive';
const CURRENT_ARCHIVE_KEY = 'current';

function unpackArchive(packed: ArrayBuffer, index: ArchiveIndex): Record<string, ArrayBuffer> {
  const files: Record<string, ArrayBuffer> = {};
  for (const entry of index) {
    files[entry.p] = packed.slice(entry.o, entry.o + entry.l);
  }
  return files;
}

function openArchiveDb(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return openIdb(indexedDB, ARCHIVE_DB_NAME, 1, db => {
    db.createObjectStore(ARCHIVE_STORE);
  });
}

async function persistArchive(indexedDB: IDBFactory, archive: PersistedArchive): Promise<void> {
  const db = await openArchiveDb(indexedDB);
  try {
    await idbTransaction(db, ARCHIVE_STORE, 'readwrite', tx => {
      tx.objectStore(ARCHIVE_STORE).put(archive, CURRENT_ARCHIVE_KEY);
    });
  } finally {
    db.close();
  }
}

async function loadPersistedArchive(indexedDB: IDBFactory): Promise<PersistedArchive | null> {
  const db = await openArchiveDb(indexedDB);
  try {
    const stored = (await idbRequest(
      db.transaction(ARCHIVE_STORE, 'readonly').objectStore(ARCHIVE_STORE).get(CURRENT_ARCHIVE_KEY),
    )) as PersistedArchive | undefined;
    return stored ?? null;
  } finally {
    db.close();
  }
}

/** The worker has no error reporting, and a failed write otherwise shows only when a restart has nothing to serve. */
function reportArchiveFailure(clients: readonly Client[], stage: 'persist' | 'restore', err: unknown): void {
  // The IndexedDB helper wraps a failed open, and the page groups failures by the browser's own error name.
  const shown = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const message = {
    type: 'ARCHIVE_FAILURE',
    stage,
    name: errorName(shown) ?? 'NonErrorThrow',
    message: errorMessage(shown),
  } as const;
  for (const client of clients) {
    client.postMessage(message);
  }
}

/** What the worker needs from its global scope. A fake stands in for it in a spec. */
export interface AppServiceWorkerDeps {
  scope: Pick<ServiceWorkerGlobalScope, 'addEventListener' | 'clients' | 'location' | 'skipWaiting'>;
  /** The origin's storage, which outlives the worker across idle restarts. */
  indexedDB: IDBFactory;
  fetch: typeof fetch;
  /** The dev server serves the sandbox's own modules under `src/`, `@` paths and `node_modules/`. */
  devServer: boolean;
}

/** Serves the archive the page hands it, from this scope's events. Each call is a fresh worker start. */
export function startAppServiceWorker({
  scope,
  indexedDB,
  fetch: fetchFromNetwork,
  devServer,
}: AppServiceWorkerDeps): void {
  const BASE = scope.location.pathname.replace(/(?:src\/)?app-sw\.[jt]s$/, '');

  let served: ServedArchive | null = null;

  /** The read-back found nothing, so the page has not sent an archive yet. */
  let nothingPersisted = false;

  /**
   * The archive kept for restarts, read back by the first fetch that finds none in memory. A failed read is not kept,
   * so the next fetch reads it again, while only the first failure is reported to the page.
   */
  const restoreArchive = createLazyLoad(
    async (): Promise<void> => {
      const archive = await loadPersistedArchive(indexedDB);
      if (archive === null) {
        nothingPersisted = true;
        return;
      }
      // A SET_ARCHIVE that landed during the read is newer. The loader keeps nothing, so a later one frees the buffers.
      served ??= { files: unpackArchive(archive.packed, archive.index), directory: archive.directory ?? BASE };
    },
    {
      onFirstMiss: err => {
        // Not awaited: the fetch waiting on this read-back must not wait on the report too.
        void scope.clients.matchAll({ type: 'window' }).then(
          clients => {
            reportArchiveFailure(clients, 'restore', err);
          },
          () => undefined,
        );
      },
    },
  );

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

  scope.addEventListener('message', (event: ExtendableMessageEvent) => {
    const data = event.data as { type?: string; [key: string]: unknown } | null;
    if (data?.type === undefined || data.type === '') {
      return;
    }

    if (data.type === 'SW_CLAIM_EVENT') {
      void scope.clients.claim();
      return;
    }

    if (data.type === 'GET_SW_VERSION') {
      // On the caller's MessageChannel port, so it needs no global listener. Older callers send no port.
      const reply = { type: 'SW_VERSION', version: SW_VERSION } as const;
      const [port] = event.ports;
      if (port !== undefined) {
        port.postMessage(reply);
      } else if (event.source) {
        (event.source as Client).postMessage(reply);
      }
      return;
    }

    if (data.type === 'SET_ARCHIVE') {
      const sender = event.source as Client | null;
      // On the handoff's own port, so a late answer cannot settle a later attempt. A page from the previous release
      // sends no port and still listens on the page-wide channel.
      const [port] = event.ports;
      const reply = (message: { type: 'ARCHIVE_READY' } | { type: 'ARCHIVE_ERROR'; reason: string }): void => {
        if (port !== undefined) {
          port.postMessage(message);
        } else {
          sender?.postMessage(message);
        }
      };

      // An ACK without a payload would leave the sender looping forever against an empty SW.
      const { packed, index: idx, directory: sent } = data as Partial<SetArchiveMessage>;

      if (packed === undefined || idx === undefined) {
        reply({ type: 'ARCHIVE_ERROR', reason: 'SET_ARCHIVE missing packed/index payload' });
        return;
      }

      // A page from the previous release names no directory, and its page needs no remap.
      const directory = typeof sent === 'string' ? sent : BASE;
      served = { files: unpackArchive(packed, idx), directory };
      // The write matters only to the next instance, so it does not hold up the ACK. `waitUntil` keeps this one alive.
      event.waitUntil(
        persistArchive(indexedDB, { packed, index: idx, directory }).catch((err: unknown) => {
          // eslint-disable-next-line no-console -- the worker has no logger, and the page reports the failure
          console.error('Failed to persist the archive; a restarted worker will not serve it:', err);
          if (sender !== null) {
            reportArchiveFailure([sender], 'persist', err);
          }
        }),
      );
      reply({ type: 'ARCHIVE_READY' });
      return;
    }
  });

  scope.addEventListener('fetch', (event: FetchEvent) => {
    const url = new URL(event.request.url);
    if (url.origin !== scope.location.origin) {
      return;
    }

    // The sandbox page and this worker come from the network. So does every navigation, since the page writes the
    // product's index.html into its own window. On the dev server the sandbox's own modules do too.
    if (
      event.request.mode === 'navigate' ||
      url.pathname === BASE ||
      url.pathname === BASE.slice(0, -1) ||
      url.pathname === `${BASE}app-sw.js` ||
      (devServer &&
        (url.pathname.startsWith(`${BASE}src/`) ||
          url.pathname.startsWith(`${BASE}node_modules/`) ||
          url.pathname.startsWith(`${BASE}@`)))
    ) {
      return;
    }

    const { request } = event;

    if (hasArchive()) {
      const found = lookupArchive(url.pathname) ?? lookupUnderPageDirectory(url.pathname);
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
          return lookupArchive(url.pathname) ?? lookupUnderPageDirectory(url.pathname) ?? fetchFromNetwork(request);
        },
        (err: unknown) => {
          // eslint-disable-next-line no-console -- the worker has no logger, and the page reports the failure
          console.error('Failed to restore the archive after a worker restart:', err);
          return fetchFromNetwork(request);
        },
      ),
    );
  });

  /**
   * The archive file a request means once the page's directory is read as the archive root.
   *
   * The page is written at the URL the visitor opened, so below the root a relative URL resolves under the page's
   * directory, while the archive holds every file from its root. The directory is the one the page was written at, not
   * the requester's current URL: a product's router moves its page elsewhere, and a product's worker is open at its own
   * script's path, yet both still ask for files under the written directory.
   */
  function lookupUnderPageDirectory(pathname: string): Response | null {
    const directory = served?.directory ?? BASE;
    if (directory.length <= BASE.length || !directory.startsWith(BASE) || !pathname.startsWith(directory)) {
      return null;
    }
    return lookupArchive(BASE + pathname.slice(directory.length));
  }

  /**
   * `null` means the path is not the archive's and must reach the network: the origin also serves the shell's own
   * assets, and a 404 for them strands a refresh on the loader.
   */
  function lookupArchive(pathname: string): Response | null {
    const decoded = archivePath(pathname, BASE);
    if (decoded === null) {
      return null;
    }
    let filePath = decoded;

    let content = getFile(filePath);

    if (content === undefined && !hasExtension(filePath)) {
      const withIndex = filePath !== '' ? filePath + '/index.html' : 'index.html';
      content = getFile(withIndex);
      if (content !== undefined) {
        filePath = withIndex;
      }
      if (content === undefined && filePath !== '') {
        const noSlash = filePath + 'index.html';
        content = getFile(noSlash);
        if (content !== undefined) {
          filePath = noSlash;
        }
      }
    }

    if (content === undefined && (filePath === '' || filePath === '/')) {
      content = getFile('index.html');
      if (content !== undefined) {
        filePath = 'index.html';
      }
    }

    if (content === undefined) {
      return null;
    }
    return new Response(content, archiveResponseInit(getMimeType(filePath)));
  }
}

/** One source, so a new header lands on every served body. */
function archiveResponseInit(mime: string): ResponseInit {
  return {
    status: 200,
    headers: {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  };
}
