// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves each page the archive it hands over. The iframe is credentialless, so this origin's storage lasts only as long
// as the host page.

/// <reference lib="webworker" />

import {
  createAsyncTaskPool,
  createDeferred,
  createStateMachine,
  isRecord,
  type HandlerOf,
  type MachineTypes,
} from '@dotli/shared';
import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import { APP_SERVICE_WORKER_NAME } from './appServiceWorkerName.js';
import {
  type IsClosedClientParams,
  isClosedClient,
  loadPersistedArchives,
  type PersistedArchive,
  type PersistedArchives,
  persistPageArchive,
  persistWorkerPage,
} from './archiveDb.js';
import type { SetArchiveMessage } from './handOverArchive.js';
import { lookupServedFile, type ServedArchive } from './lookupServedFile.js';
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

/** The archives the worker serves, by the client each belongs to. */
type Archives = {
  /** Each page's own archive, by the id of the page's client. */
  byClient: ReadonlyMap<string, ServedArchive>;
  /** A worker a page started, by the worker client's id, to the id of that page's client. */
  workerPages: ReadonlyMap<string, string>;
  /** The archive handed last, for a client the worker cannot place. */
  newest: ServedArchive | null;
};

/** What a restarted worker read back from the store, unpacked. */
type RestoredArchives = {
  byClient: ReadonlyMap<string, ServedArchive>;
  workerPages: ReadonlyMap<string, string>;
  /** The client whose archive was handed last, or `null` when none was. */
  newestId: string | null;
};

/** A fetch the read-back holds, and the response it is answered with. */
type HeldFetch = {
  request: Request;
  clientId: string;
  pathname: string;
  response: ReturnType<typeof createDeferred<Response>>;
};

/**
 * The archives in memory, and whether the worker has read the store back since it started. `held` are the fetches the
 * read in flight answers, and `missedBefore` says whether a read failed before, since only the first failure is
 * reported to the pages.
 */
type WorkerState =
  | { kind: 'unread'; archives: Archives; missedBefore: boolean }
  | { kind: 'reading'; archives: Archives; held: readonly HeldFetch[]; missedBefore: boolean }
  | { kind: 'read'; archives: Archives };

type WorkerEvent =
  | { kind: 'requested'; event: FetchEvent; pathname: string }
  | { kind: 'archiveHanded'; clientId: string; archive: ServedArchive }
  | { kind: 'workerLinked'; workerId: string; pageId: string }
  | { kind: 'clientsClosed'; closed: IsClosedClientParams }
  | { kind: 'archivesRestored'; restored: RestoredArchives }
  | { kind: 'restoreMissed'; error: unknown };

/**
 * A fetch answered from the archive, held fetches answered once the read-back ended, a read-back that failed, for the
 * worker's log, and its first failure, for the pages.
 */
type WorkerEffect =
  | { kind: 'respond'; event: FetchEvent; response: Response | Promise<Response> }
  | { kind: 'answerHeld'; held: readonly HeldFetch[]; archives: Archives }
  | { kind: 'restoreMissed'; error: unknown }
  | { kind: 'firstRestoreMissed'; error: unknown };

type WorkerMachine = MachineTypes<WorkerState, WorkerEvent, WorkerEffect>;

type AnyKind = WorkerState['kind'];

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

/** A handed archive serves its page, and is the newest. */
const handArchive: HandlerOf<WorkerMachine, AnyKind, 'archiveHanded'> = (
  state,
  { clientId, archive },
  { emitState },
) => {
  const byClient = new Map(state.archives.byClient).set(clientId, archive);
  emitState({ ...state, archives: { ...state.archives, byClient, newest: archive } });
};

/** A worker a page started is served that page's archive. */
const linkWorker: HandlerOf<WorkerMachine, AnyKind, 'workerLinked'> = (state, { workerId, pageId }, { emitState }) => {
  const workerPages = new Map(state.archives.workerPages).set(workerId, pageId);
  emitState({ ...state, archives: { ...state.archives, workerPages } });
};

/** Drops the archives and links of clients that are not open, except the sender's, which was open to send. */
const dropClosed: HandlerOf<WorkerMachine, AnyKind, 'clientsClosed'> = (state, { closed }, { emitState }) => {
  const { archives } = state;
  const byClient = new Map([...archives.byClient].filter(([clientId]) => !isClosedClient(clientId, closed)));
  const workerPages = new Map([...archives.workerPages].filter(([workerId]) => !isClosedClient(workerId, closed)));
  emitState({ ...state, archives: { ...archives, byClient, workerPages } });
};

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

  // One write at a time, so the store's newest archive is the last one handed over, whatever order the reads finish in.
  const persists = createAsyncTaskPool({ poolSize: 1 });

  // The archives kept for restarts are read back by the first fetch whose client has none in memory, and the fetches
  // that arrive during the read wait for it. A failed read is not kept, so the next such fetch reads them again, while
  // only the first failure is reported to the pages. A read that succeeded is merged and kept by nothing else.
  const worker = createStateMachine<WorkerMachine>({
    initial: {
      kind: 'unread',
      archives: { byClient: new Map(), workerPages: new Map(), newest: null },
      missedBefore: false,
    },
    handlers: {
      unread: {
        requested(state, { event, pathname }, { emitState, emitSideEffect, update }) {
          const own = getClientArchive(state.archives, event.clientId);
          if (own !== null) {
            serveFromMemory({ event, archive: own, pathname }, emitSideEffect);
            return;
          }
          // A restarted worker reads the archives back first, since nginx answers every path with the shell as
          // `text/html`.
          const held = holdFetch(event, pathname);
          emitState({ kind: 'reading', archives: state.archives, held: [held], missedBefore: state.missedBefore });
          emitSideEffect({ kind: 'respond', event, response: held.response.promise });
          update(
            loadPersistedArchives(indexedDB)
              .then(unpackRestored)
              .then(
                restored => ({ kind: 'archivesRestored', restored }),
                (error: unknown) => ({ kind: 'restoreMissed', error }),
              ),
          );
        },
        archiveHanded: handArchive,
        workerLinked: linkWorker,
        clientsClosed: dropClosed,
      },
      reading: {
        requested(state, { event, pathname }, { emitState, emitSideEffect }) {
          const own = getClientArchive(state.archives, event.clientId);
          if (own !== null) {
            serveFromMemory({ event, archive: own, pathname }, emitSideEffect);
            return;
          }
          const held = holdFetch(event, pathname);
          emitState({ ...state, held: [...state.held, held] });
          emitSideEffect({ kind: 'respond', event, response: held.response.promise });
        },
        archivesRestored({ archives, held }, { restored }, { emitState, emitSideEffect }) {
          const merged = mergeRestored(archives, restored);
          emitState({ kind: 'read', archives: merged });
          emitSideEffect({ kind: 'answerHeld', held, archives: merged });
        },
        restoreMissed({ archives, held, missedBefore }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'unread', archives, missedBefore: true });
          emitSideEffect({ kind: 'restoreMissed', error });
          if (!missedBefore) {
            emitSideEffect({ kind: 'firstRestoreMissed', error });
          }
          emitSideEffect({ kind: 'answerHeld', held, archives });
        },
        archiveHanded: handArchive,
        workerLinked: linkWorker,
        clientsClosed: dropClosed,
      },
      read: {
        requested({ archives }, { event, pathname }, { emitSideEffect }) {
          const archive = getClientArchive(archives, event.clientId) ?? archives.newest;
          if (archive !== null) {
            serveFromMemory({ event, archive, pathname }, emitSideEffect);
          }
        },
        archiveHanded: handArchive,
        workerLinked: linkWorker,
        clientsClosed: dropClosed,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'respond':
          effect.event.respondWith(effect.response);
          return;
        case 'answerHeld':
          for (const { request, clientId, pathname, response } of effect.held) {
            answerFromMemory({ request, clientId, pathname, archives: effect.archives }).then(
              response.resolve,
              response.reject,
            );
          }
          return;
        case 'restoreMissed':
          // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
          console.error('Failed to restore the archives after a worker restart:', effect.error);
          return;
        case 'firstRestoreMissed':
          // Not awaited: the fetches this read-back held must not wait on the report too.
          void reportToPages({ stage: 'restore', error: effect.error });
          return;
      }
    },
    onError: error => {
      // eslint-disable-next-line no-console -- the worker has no logger, and it reports the defect to its pages
      console.error('The archive worker failed a transition:', error);
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
    worker.update({ kind: 'requested', event, pathname: url.pathname });
  }

  /** Answers `event` from `archive` when it holds the path, and else leaves the request to the network. */
  function serveFromMemory(
    { event, archive, pathname }: { event: FetchEvent; archive: ServedArchive; pathname: string },
    emitSideEffect: (effect: WorkerEffect) => void,
  ): void {
    const found = lookupServedFile(archive, pathname, basePath);
    if (found !== null) {
      emitSideEffect({ kind: 'respond', event, response: found });
    }
  }

  /**
   * Answers a held fetch from its client's archive or the newest, and else from the network. Rejects as the network's
   * fetch does, or with what the lookup throws.
   */
  function answerFromMemory({
    request,
    clientId,
    pathname,
    archives,
  }: Omit<HeldFetch, 'response'> & { archives: Archives }): Promise<Response> {
    return new Promise(resolve => {
      const archive = getClientArchive(archives, clientId) ?? archives.newest;
      resolve((archive === null ? null : lookupServedFile(archive, pathname, basePath)) ?? fetchFromNetwork(request));
    });
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
    worker.update({ kind: 'workerLinked', workerId, pageId });
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
    worker.update({
      kind: 'archiveHanded',
      clientId: sender.id,
      archive: { files: unpackArchive(packed, index), directory },
    });
    // The write matters only to the next instance, so it does not hold up the ACK. `waitUntil` keeps this one alive.
    event.waitUntil(
      persists
        .call(() => keepPageArchive(sender.id, { packed, index, directory }))
        .catch((error: unknown) => {
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
    worker.update({ kind: 'clientsClosed', closed: { clientId, liveClientIds } });
    await persistPageArchive(indexedDB, { clientId, archive, liveClientIds });
  }
}

/** The client's own archive, else the archive of the page that started it. `null` when memory holds neither. */
function getClientArchive({ byClient, workerPages }: Archives, clientId: string): ServedArchive | null {
  const own = byClient.get(clientId);
  if (own !== undefined) {
    return own;
  }
  const pageId = workerPages.get(clientId);
  return pageId === undefined ? null : (byClient.get(pageId) ?? null);
}

/** Fills in what the store kept only where memory has nothing, since a handoff that landed during the read is newer. */
function mergeRestored(archives: Archives, { byClient, workerPages, newestId }: RestoredArchives): Archives {
  const mergedByClient = new Map([...byClient, ...archives.byClient]);
  const newest = archives.newest ?? (newestId === null ? null : (mergedByClient.get(newestId) ?? null));
  return {
    byClient: mergedByClient,
    workerPages: new Map([...workerPages, ...archives.workerPages]),
    newest,
  };
}

/** A fetch held until the read-back ends, with the response it will be answered with. */
function holdFetch({ request, clientId }: FetchEvent, pathname: string): HeldFetch {
  return { request, clientId, pathname, response: createDeferred<Response>() };
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

/** The store's records with each page's archive unpacked. */
function unpackRestored({ pages, workerPages, newest }: PersistedArchives): RestoredArchives {
  const byClient = new Map<string, ServedArchive>();
  for (const [clientId, { packed, index, directory }] of pages) {
    byClient.set(clientId, { files: unpackArchive(packed, index), directory });
  }
  return { byClient, workerPages, newestId: newest };
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
