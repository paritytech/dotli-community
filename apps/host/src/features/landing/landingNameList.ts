// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's app labels: the stored list at once, then each step of one sync on the page's Asset Hub lease.

import { hasLightClient, NETWORK_NAME_TO_SERVICES_CONFIG, type Backend } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import { isExpectedReadError, loadResolve, type DotnsResolver } from '@dotli/resolver';
import { nameList, type NameList } from '@dotli/storage';
import { atom, type ReadableAtom } from 'nanostores';
import { createNameListTrace, type NameListTrace } from './createNameListTrace.js';
import { loadHostBridge } from '../productRuntime/index.js';
import { reportLazyMiss } from '../../kit/reportLazyMiss.js';
import { settingsState, type SettingsState } from '../settings/index.js';
import { syncNameList, type NameListReads } from './syncNameList.js';

type Params = {
  store: NameList;
  /** Builds the reads on the page's Asset Hub lease for the settled settings. Rejects when a chunk fails to load. */
  openReads: (settings: SettingsState) => Promise<NameListReads & Pick<DotnsResolver, 'release'>>;
  /** The page's settings, null until the boot sets them. */
  settings: ReadableAtom<SettingsState | null>;
  /** Opens the trace of one sync on the page's performance timeline. */
  openTrace?: (backend: Backend) => NameListTrace;
  now?: () => number;
};

const report = createReporter({ flow: 'name_list' });

/** One sync of the landing page's name list. Tagged `outcome` (ok, error) and `reason` (the error's name). */
const nameListSyncMetric = defineCount<'ok' | 'error'>('name_list.sync');

/** Builds the landing page's app labels, which one sync on the Asset Hub lease brings up to date. */
export function createLandingNameList({
  store,
  openReads,
  settings,
  openTrace = backend => createNameListTrace({ backend }),
  now = Date.now,
}: Params) {
  const labels = atom<readonly string[]>([]);
  const labelsStore: ReadableAtom<readonly string[]> = labels;
  const syncing = atom(false);
  const syncingStore: ReadableAtom<boolean> = syncing;
  // A latch, since the page runs one sync and a second start must not queue another.
  let started = false;
  // The stop of the page's one sync, which a clear fires.
  const controller = new AbortController();
  const { signal } = controller;

  return {
    /** The app labels to suggest from: the stored ones once read, then each saved step's. */
    labels: labelsStore,
    /** True while the page's one sync may still bring labels: from its start until it ends or a clear stops it. */
    syncing: syncingStore,
    /** Starts the page's one sync once the settings are set. Again does nothing. */
    start,
    /**
     * Stops the page's sync so none of its saves lands after the clear, then empties every network's stored list.
     * Resolves once the clear commits. Again is safe.
     */
    clear,
  };

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    const current = settings.get();
    if (current !== null) {
      void sync(current);
      return;
    }
    const unlisten = settings.listen(next => {
      if (next === null) {
        return;
      }
      unlisten();
      void sync(next);
    });
  }

  async function clear(): Promise<void> {
    controller.abort();
    syncing.set(false);
    await store.clear();
  }

  async function sync(current: SettingsState): Promise<void> {
    const trace = openTrace(current.backend);
    // A sync after a clear saves nothing, so it brings no labels.
    syncing.set(!signal.aborted);
    try {
      await runSync(current, trace);
    } catch (error) {
      trace.ended({ kind: 'error', error });
      // The user's stop, since the user cleared the list. Any other error, even one after the clear, is a failure.
      if (signal.aborted && error === signal.reason) {
        return;
      }
      if (isExpectedReadError(error)) {
        report.expected(error, { step: 'sync', metric: nameListSyncMetric });
      } else {
        report.defect(error, { step: 'sync', metric: nameListSyncMetric, message: '[dot.li name-list] sync failed:' });
      }
    } finally {
      syncing.set(false);
    }
  }

  async function runSync(current: SettingsState, trace: NameListTrace): Promise<void> {
    const { network } = current;
    const stored = await store.get(network);
    trace.storedRead(stored);
    labels.set(stored?.apps ?? []);
    trace.labelsShown(stored?.apps.length ?? 0);
    let reads: Awaited<ReturnType<Params['openReads']>>;
    try {
      reads = await openReads(current);
    } catch (error) {
      trace.ended({ kind: 'error', error });
      reportLazyMiss({ report, step: 'name_list_reads', error });
      return;
    }
    trace.readsOpened();
    try {
      await syncNameList({
        stored,
        network,
        reads: trace.withReads(reads),
        now,
        save: async record => {
          // A save past this check asked for the connection before a later clear did, so it commits first.
          signal.throwIfAborted();
          // Saved first, so a `labels` listener that throws never loses the chunk.
          await store.set(record);
          labels.set(record.apps);
          trace.labelsShown(record.apps.length);
        },
      });
    } finally {
      reads.release();
    }
    trace.ended({ kind: 'ok' });
    nameListSyncMetric.count({ outcome: 'ok' });
  }
}

/** The page's app labels, synced on the host chain pool's Asset Hub lease. */
export const landingNameList = createLandingNameList({
  store: nameList,
  openReads: openPageReads,
  settings: settingsState.store,
});

/** Builds the resolver on the host chain pool's Asset Hub lease. Rejects when its chunk or the bridge fails to load. */
async function openPageReads(settings: SettingsState): Promise<DotnsResolver> {
  const [resolveModule, bridge] = await Promise.all([loadResolve(), loadHostBridge()]);
  return resolveModule.createDotnsResolver({
    assetHub: bridge.getHostAssetHubProvider,
    dotns: NETWORK_NAME_TO_SERVICES_CONFIG[settings.network].dotns,
    source: hasLightClient(settings.backend) ? 'light-client' : 'rpc-gateway',
  });
}
