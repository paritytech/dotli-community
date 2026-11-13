// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves each page the archive it hands over. The iframe is credentialless, so this origin's storage lasts only as long
// as the host page.

/// <reference lib="webworker" />

import {
  createAsyncTaskPool,
  createDeferred,
  createStateMachine,
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
import { lookupServedFile, type ServedArchive } from './lookupServedFile.js';
import { getSender, hasArchivePayload, isPageMessage, replyToPage, type SetArchiveRequest } from './pageMessages.js';
import { reportArchiveFailure, type ArchiveStage } from './reportArchiveFailure.js';
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

/** A read-back of the store, which ends with the archives the fetches it held are answered from. */
type ReadBack = ReturnType<typeof createDeferred<Archives>>;

/**
 * A sweep of the clients that closed. While it lists the open clients, the ids handed over or linked since are `spared`,
 * since the listing may have been taken before they opened.
 */
type Sweep = { kind: 'idle' } | { kind: 'listing'; spared: ReadonlySet<string> };

/**
 * The archives in memory, and whether the worker has read the store back since it started. `readBack` is the read in
 * flight, and `missedBefore` says whether a read failed before, since only the first failure is reported to the pages.
 */
type WorkerState =
  | { kind: 'unread'; archives: Archives; sweep: Sweep; missedBefore: boolean }
  | { kind: 'reading'; archives: Archives; sweep: Sweep; readBack: ReadBack; missedBefore: boolean }
  | { kind: 'read'; archives: Archives; sweep: Sweep };

type WorkerEvent =
  | { kind: 'requested'; event: FetchEvent; pathname: string }
  | { kind: 'archiveHanded'; clientId: string; archive: ServedArchive }
  | { kind: 'workerLinked'; workerId: string; pageId: string }
  | { kind: 'sweepStarted' }
  | { kind: 'clientsClosed'; closed: IsClosedClientParams }
  | { kind: 'archivesRestored'; restored: Archives }
  | { kind: 'restoreMissed'; error: unknown };

type WorkerEffect =
  /** A fetch answered from `archive` when it holds the path. */
  | { kind: 'serve'; event: FetchEvent; archive: ServedArchive; pathname: string }
  /** A fetch answered once `readBack` ends. */
  | { kind: 'respondAfterRead'; event: FetchEvent; pathname: string; readBack: ReadBack }
  /** A read-back that ended with the archives its fetches are answered from. */
  | { kind: 'readEnded'; readBack: ReadBack; archives: Archives }
  /** A read-back that failed, for the worker's log. */
  | { kind: 'restoreMissed'; error: unknown }
  /** The first read-back that failed, for the pages. */
  | { kind: 'firstRestoreMissed'; error: unknown };

type WorkerMachine = MachineTypes<WorkerState, WorkerEvent, WorkerEffect>;

/** The stage a throw of each effect is a failure of. */
const EFFECT_STAGES = {
  serve: 'serve',
  respondAfterRead: 'serve',
  readEnded: 'restore',
  restoreMissed: 'restore',
  firstRestoreMissed: 'restore',
} satisfies Record<WorkerEffect['kind'], ArchiveStage>;

// The build the worker names when a page asks for its version. A build inlines it as a literal, so the worker's bytes
// change between releases and the browser never skips the update as byte-identical.
const WORKER_VERSION = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

/** A handed archive serves its page, and is the newest. */
const handArchive: HandlerOf<WorkerMachine, WorkerState['kind'], 'archiveHanded'> = (
  state,
  { clientId, archive },
  { emitState },
) => {
  const byClient = new Map(state.archives.byClient).set(clientId, archive);
  emitState({
    ...state,
    archives: { ...state.archives, byClient, newest: archive },
    sweep: spare(state.sweep, clientId),
  });
};

/** A worker a page started is served that page's archive. */
const linkWorker: HandlerOf<WorkerMachine, WorkerState['kind'], 'workerLinked'> = (
  state,
  { workerId, pageId },
  { emitState },
) => {
  const workerPages = new Map(state.archives.workerPages).set(workerId, pageId);
  emitState({ ...state, archives: { ...state.archives, workerPages }, sweep: spare(state.sweep, workerId) });
};

/** Starts a sweep, which spares from now on what is handed over or linked until the open clients are listed. */
const startSweep: HandlerOf<WorkerMachine, WorkerState['kind'], 'sweepStarted'> = (state, _event, { emitState }) => {
  emitState({ ...state, sweep: { kind: 'listing', spared: new Set() } });
};

/**
 * Ends the sweep: drops the archives and links of clients that are not open, except the sender's, which was open to
 * send, and those the sweep spares.
 */
const dropClosed: HandlerOf<WorkerMachine, WorkerState['kind'], 'clientsClosed'> = (
  state,
  { closed },
  { emitState },
) => {
  const { archives, sweep } = state;
  const spared = sweep.kind === 'listing' ? sweep.spared : new Set<string>();
  const isDropped = (id: string) => isClosedClient(id, closed) && !spared.has(id);
  const byClient = new Map([...archives.byClient].filter(([clientId]) => !isDropped(clientId)));
  const workerPages = new Map([...archives.workerPages].filter(([workerId]) => !isDropped(workerId)));
  emitState({ ...state, archives: { ...archives, byClient, workerPages }, sweep: { kind: 'idle' } });
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
      sweep: { kind: 'idle' },
      missedBefore: false,
    },
    handlers: {
      unread: {
        requested(state, { event, pathname }, { emitState, emitSideEffect, update }) {
          const own = getClientArchive(state.archives, event.clientId);
          if (own !== null) {
            emitSideEffect({ kind: 'serve', event, archive: own, pathname });
            return;
          }
          // A restarted worker reads the archives back first, since nginx answers every path with the shell as
          // `text/html`.
          const readBack: ReadBack = createDeferred();
          const { archives, sweep, missedBefore } = state;
          emitState({ kind: 'reading', archives, sweep, readBack, missedBefore });
          emitSideEffect({ kind: 'respondAfterRead', event, pathname, readBack });
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
        sweepStarted: startSweep,
        clientsClosed: dropClosed,
      },
      reading: {
        requested({ archives, readBack }, { event, pathname }, { emitSideEffect }) {
          const own = getClientArchive(archives, event.clientId);
          if (own !== null) {
            emitSideEffect({ kind: 'serve', event, archive: own, pathname });
            return;
          }
          emitSideEffect({ kind: 'respondAfterRead', event, pathname, readBack });
        },
        archivesRestored({ archives, sweep, readBack }, { restored }, { emitState, emitSideEffect }) {
          // What the store kept fills in only where memory has nothing, since a handoff during the read is newer.
          const merged: Archives = {
            byClient: new Map([...restored.byClient, ...archives.byClient]),
            workerPages: new Map([...restored.workerPages, ...archives.workerPages]),
            newest: archives.newest ?? restored.newest,
          };
          emitState({ kind: 'read', archives: merged, sweep });
          emitSideEffect({ kind: 'readEnded', readBack, archives: merged });
        },
        restoreMissed({ archives, sweep, readBack, missedBefore }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'unread', archives, sweep, missedBefore: true });
          emitSideEffect({ kind: 'restoreMissed', error });
          if (!missedBefore) {
            emitSideEffect({ kind: 'firstRestoreMissed', error });
          }
          emitSideEffect({ kind: 'readEnded', readBack, archives });
        },
        archiveHanded: handArchive,
        workerLinked: linkWorker,
        sweepStarted: startSweep,
        clientsClosed: dropClosed,
      },
      read: {
        requested({ archives }, { event, pathname }, { emitSideEffect }) {
          const archive = getClientArchive(archives, event.clientId) ?? archives.newest;
          if (archive !== null) {
            emitSideEffect({ kind: 'serve', event, archive, pathname });
          }
        },
        archiveHanded: handArchive,
        workerLinked: linkWorker,
        sweepStarted: startSweep,
        clientsClosed: dropClosed,
      },
    },
    onEffect: effect => {
      try {
        runEffect(effect);
      } catch (error) {
        reportDefect(error, EFFECT_STAGES[effect.kind]);
      }
    },
    // Each effect reports its own throw, so only a handler's lands here.
    onError: error => {
      reportDefect(error, 'transition');
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

  function runEffect(effect: WorkerEffect): void {
    switch (effect.kind) {
      case 'serve': {
        // A path the archive does not hold is left to the network.
        const found = lookupServedFile(effect.archive, effect.pathname, basePath);
        if (found !== null) {
          effect.event.respondWith(found);
        }
        return;
      }
      case 'respondAfterRead':
        effect.event.respondWith(answerAfterRead(effect));
        return;
      case 'readEnded':
        effect.readBack.resolve(effect.archives);
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
  }

  /** Logs a defect of the worker at `stage` and tells the pages. */
  function reportDefect(error: unknown, stage: ArchiveStage): void {
    // eslint-disable-next-line no-console -- the worker has no logger, and it reports the defect to its pages
    console.error(`The archive worker failed at ${stage}:`, error);
    void reportToPages({ stage, error });
  }

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

  /**
   * Answers a fetch once `readBack` ends, from its client's archive or the newest, and else from the network. Rejects as
   * the network's fetch does, or with what the lookup throws.
   */
  function answerAfterRead({
    readBack,
    event: { request, clientId },
    pathname,
  }: Extract<WorkerEffect, { kind: 'respondAfterRead' }>): Promise<Response> {
    return readBack.promise.then(archives => {
      const archive = getClientArchive(archives, clientId) ?? archives.newest;
      return (archive === null ? null : lookupServedFile(archive, pathname, basePath)) ?? fetchFromNetwork(request);
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
    // In the same queue as the archive writes, so a write that lists the open clients first never drops this link.
    event.waitUntil(
      persists
        .call(() => persistWorkerPage(indexedDB, { workerId, pageId }))
        .catch((error: unknown) => {
          // eslint-disable-next-line no-console -- the worker has no logger, and it reports the failure to its pages
          console.error(
            "Failed to persist a worker's page; a restarted worker will serve it the newest archive:",
            error,
          );
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
    worker.update({ kind: 'sweepStarted' });
    const clients = await scope.clients.matchAll({ includeUncontrolled: true, type: 'all' });
    const liveClientIds = new Set(clients.map(client => client.id));
    worker.update({ kind: 'clientsClosed', closed: { clientId, liveClientIds } });
    await persistPageArchive(indexedDB, { clientId, archive, liveClientIds });
  }
}

/** `sweep` with `id` spared when it is listing. */
function spare(sweep: Sweep, id: string): Sweep {
  switch (sweep.kind) {
    case 'idle':
      return sweep;
    case 'listing':
      return { kind: 'listing', spared: new Set(sweep.spared).add(id) };
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

/** The store's records with each page's archive unpacked. */
function unpackRestored({ pages, workerPages, newest }: PersistedArchives): Archives {
  const byClient = new Map<string, ServedArchive>();
  for (const [clientId, { packed, index, directory }] of pages) {
    byClient.set(clientId, { files: unpackArchive(packed, index), directory });
  }
  return { byClient, workerPages, newest: newest === null ? null : (byClient.get(newest) ?? null) };
}

/** Whether a request fetches the script of a product's worker. */
function isWorkerScript(request: Request): boolean {
  return request.destination === 'worker' || request.destination === 'sharedworker';
}
