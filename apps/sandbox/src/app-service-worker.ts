// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the archive the page hands it. The iframe is credentialless, so this origin's storage lasts only as long as
// the host page, and the host keeps the content blocks instead.

/// <reference lib="webworker" />

import { injectSandboxChecker } from '@dotli/sandbox-checker';
import { getMimeType } from './mime.js';
import stripAppPrefixScript from './head/strip-app-prefix.js?inline-script';

// The page reads it through `GET_SW_VERSION` to detect a stale worker. A build inlines it as a literal, so the worker's
// bytes change between releases and the browser never skips the update as byte-identical.
const SW_VERSION = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  return lastDot > lastSlash;
}

// The browser stops an idle worker after about 30s, so the archive is also kept in IndexedDB and read back on the
// first fetch after a restart.

type ArchiveIndex = { p: string; o: number; l: number }[];

interface PersistedArchive {
  packed: ArrayBuffer;
  index: ArchiveIndex;
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
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ARCHIVE_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open the archive database'));
    };
  });
}

async function persistArchive(indexedDB: IDBFactory, archive: PersistedArchive): Promise<void> {
  const db = await openArchiveDb(indexedDB);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ARCHIVE_STORE, 'readwrite');
      tx.objectStore(ARCHIVE_STORE).put(archive, CURRENT_ARCHIVE_KEY);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('Failed to persist the archive'));
      };
    });
  } finally {
    db.close();
  }
}

async function loadPersistedArchive(indexedDB: IDBFactory): Promise<PersistedArchive | null> {
  const db = await openArchiveDb(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(ARCHIVE_STORE, 'readonly').objectStore(ARCHIVE_STORE).get(CURRENT_ARCHIVE_KEY);
      request.onsuccess = () => {
        resolve((request.result as PersistedArchive | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to read the archive'));
      };
    });
  } finally {
    db.close();
  }
}

/** The worker has no error reporting, and a failed write otherwise shows only when a restart has nothing to serve. */
function reportArchiveFailure(clients: readonly Client[], stage: 'persist' | 'restore', err: unknown): void {
  const message = {
    type: 'ARCHIVE_FAILURE',
    stage,
    name: err instanceof Error ? err.name : 'NonErrorThrow',
    message: err instanceof Error ? err.message : String(err),
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
}

/** Serves the archive the page hands it, from this scope's events. Each call is a fresh worker start. */
export function startAppServiceWorker({ scope, indexedDB, fetch: fetchFromNetwork }: AppServiceWorkerDeps): void {
  const BASE = scope.location.pathname.replace(/(?:src\/)?app-sw\.[jt]s$/, '');
  const DOTLI_APP_PREFIX = `${BASE}dotli-app/`;

  let servedFiles: Record<string, ArrayBuffer> | null = null;

  /** Started by the first fetch that finds no archive in memory. */
  let restoring: Promise<void> | null = null;

  /** The read-back found nothing, so the page has not sent an archive yet. */
  let nothingPersisted = false;

  function restoreArchive(): Promise<void> {
    restoring ??= loadPersistedArchive(indexedDB).then(
      archive => {
        if (archive === null) {
          nothingPersisted = true;
          return;
        }
        // A SET_ARCHIVE that landed while the read was in flight is newer.
        servedFiles ??= unpackArchive(archive.packed, archive.index);
      },
      (err: unknown) => {
        // eslint-disable-next-line no-console -- the worker has no logger, and the page reports the failure
        console.error('Failed to restore the archive after a worker restart:', err);
        nothingPersisted = true;
        // Not awaited: the fetch waiting on this read-back must not wait on the report too.
        void scope.clients.matchAll({ type: 'window' }).then(
          clients => {
            reportArchiveFailure(clients, 'restore', err);
          },
          () => undefined,
        );
      },
    );
    return restoring;
  }

  function hasArchive(): boolean {
    return servedFiles !== null;
  }

  function getFile(path: string): ArrayBuffer | undefined {
    return servedFiles !== null && Object.hasOwn(servedFiles, path) ? servedFiles[path] : undefined;
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
      const packed = data['packed'] as ArrayBuffer | undefined;
      const idx = data['index'] as ArchiveIndex | undefined;

      if (packed === undefined || idx === undefined) {
        reply({ type: 'ARCHIVE_ERROR', reason: 'SET_ARCHIVE missing packed/index payload' });
        return;
      }

      servedFiles = unpackArchive(packed, idx);
      // The write matters only to the next instance, so it does not hold up the ACK. `waitUntil` keeps this one alive.
      event.waitUntil(
        persistArchive(indexedDB, { packed, index: idx }).catch((err: unknown) => {
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

    // SW infrastructure goes to the network. An archive that ships its own `node_modules/` is not served from it.
    if (
      url.pathname === BASE ||
      url.pathname === BASE.slice(0, -1) ||
      url.pathname === `${BASE}app-sw.js` ||
      url.pathname.startsWith(`${BASE}src/`) ||
      url.pathname.startsWith(`${BASE}node_modules/`) ||
      url.pathname.startsWith(`${BASE}@`)
    ) {
      return;
    }

    if (event.request.mode === 'navigate' && !url.pathname.startsWith(DOTLI_APP_PREFIX)) {
      return;
    }

    if (hasArchive()) {
      const result = lookupArchive(url.pathname, event.request.mode);
      if (result !== null) {
        event.respondWith(result);
      }
      return;
    }

    if (nothingPersisted) {
      const result = noArchiveResponse(url.pathname);
      if (result !== null) {
        event.respondWith(result);
      }
      return;
    }

    // A restarted worker reads the archive back first, since nginx answers every path with the shell as `text/html`.
    const { request } = event;
    event.respondWith(
      restoreArchive().then(
        () =>
          (hasArchive() ? lookupArchive(url.pathname, request.mode) : noArchiveResponse(url.pathname)) ??
          fetchFromNetwork(request),
      ),
    );
  });

  /**
   * App paths get a 503 rather than nginx's shell HTML under the wrong MIME type. `null` lets the sandbox's own assets
   * reach the network.
   */
  function noArchiveResponse(pathname: string): Response | null {
    if (!pathname.startsWith(DOTLI_APP_PREFIX)) {
      return null;
    }
    return new Response(null, {
      status: 503,
      statusText: 'App archive not yet loaded',
    });
  }

  /**
   * `null` means the path is not the archive's and must reach the network: the origin also serves the shell's own
   * assets, and a 404 for them strands a refresh on the loader.
   */
  function lookupArchive(pathname: string, requestMode: RequestMode): Response | null {
    let filePath = pathname.startsWith(DOTLI_APP_PREFIX)
      ? pathname.slice(DOTLI_APP_PREFIX.length)
      : pathname.startsWith(BASE)
        ? pathname.slice(BASE.length)
        : pathname.slice(1);

    filePath = decodeURIComponent(filePath);

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

    if (content !== undefined) {
      const mime = getMimeType(filePath);
      if (mime === 'text/html') {
        if (pathname === `${DOTLI_APP_PREFIX}index.html` || pathname === DOTLI_APP_PREFIX) {
          return makePrimaryHtmlResponse(content, mime);
        }
        return makeHtmlResponse(content, mime, DOTLI_APP_PREFIX);
      }
      return new Response(content, archiveResponseInit(mime));
    }

    // Only navigations fall back to the SPA index, so shell assets still reach nginx.
    if (requestMode === 'navigate') {
      const indexHtml = getFile('index.html');
      if (!hasExtension(filePath) && indexHtml !== undefined) {
        return makeHtmlResponse(indexHtml, 'text/html', DOTLI_APP_PREFIX);
      }
    }

    return null;
  }
}

function injectSandboxScript(html: string): string {
  if (import.meta.env.VITE_SANDBOX_CHECKER === undefined) {
    return html;
  }
  return injectSandboxChecker(html);
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

/** No base href or prefix stripping, which only sub-pages need. */
function makePrimaryHtmlResponse(content: ArrayBuffer | Uint8Array, mime: string): Response {
  let html = new TextDecoder().decode(content);
  html = injectSandboxScript(html);
  return new Response(new TextEncoder().encode(html), archiveResponseInit(mime));
}

function makeHtmlResponse(content: ArrayBuffer | Uint8Array, mime: string, appPrefix: string): Response {
  let html = new TextDecoder().decode(content);
  const prefixNoSlash = appPrefix.slice(0, -1);
  // A replacer function, so no `$` pattern in the script is read as a replacement pattern.
  html = html.replace(
    '<head>',
    () => `<head><base href="${appPrefix}"><script data-prefix="${prefixNoSlash}">${stripAppPrefixScript}</script>`,
  );
  html = injectSandboxScript(html);
  return new Response(new TextEncoder().encode(html), archiveResponseInit(mime));
}
