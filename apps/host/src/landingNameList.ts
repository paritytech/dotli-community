// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's app labels: the stored list at once, then each step of one sync on the page's Asset Hub lease.

import { getActiveServicesConfig, hasLightClient } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import { isApiStoppedError, loadResolve, type DotnsResolver, type ResolverErrorName } from '@dotli/resolver';
import { getErrorName, isChainHaltedRpcError } from '@dotli/shared';
import { nameList } from '@dotli/storage';
import { atom, type ReadableAtom } from 'nanostores';
import { loadHostBridge } from './lazy.js';
import { reportLazyMiss } from './reportLazyMiss.js';
import { settingsState, type SettingsState } from './state/settingsState.js';
import { syncNameList, type NameListReads } from './syncNameList.js';

type Params = {
  store: Pick<typeof nameList, 'get' | 'set'>;
  /** Builds the reads on the page's Asset Hub lease for the settled settings. Rejects when a chunk fails to load. */
  openReads: (settings: SettingsState) => Promise<NameListReads & Pick<DotnsResolver, 'release'>>;
  /** The page's settings, null until the boot sets them. */
  settings: ReadableAtom<SettingsState | null>;
  now?: () => number;
};

const report = createReporter({ flow: 'name_list' });

/** One sync of the landing page's name list. Tagged `outcome` (ok, error) and `reason` (the error's name). */
const nameListSyncMetric = defineCount<'ok' | 'error'>('name_list.sync');

// What the environment causes: a sync timeout, an operation the server refused or dropped, and a follow gone disjoint.
const EXPECTED_FAILURE_NAMES: ReadonlySet<string> = new Set([
  'NetworkSyncTimeoutError' satisfies ResolverErrorName,
  'OperationInaccessibleError',
  'OperationLimitError',
  'DisjointError',
]);

/** Builds the landing page's app labels, which one sync on the Asset Hub lease brings up to date. */
export function createLandingNameList({ store, openReads, settings, now = Date.now }: Params) {
  const labels = atom<readonly string[]>([]);
  const labelsStore: ReadableAtom<readonly string[]> = labels;
  // A latch, since the page runs one sync and a second start must not queue another.
  let started = false;

  return {
    /** The app labels to suggest from: the stored ones once read, then each saved step's. */
    labels: labelsStore,
    /** Starts the page's one sync once the settings are set. Again does nothing. Never throws. */
    start,
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

  async function sync(current: SettingsState): Promise<void> {
    const { network } = current;
    const stored = await store.get(network);
    labels.set(stored?.apps ?? []);
    let reads: Awaited<ReturnType<Params['openReads']>>;
    try {
      reads = await openReads(current);
    } catch (error) {
      reportLazyMiss({ report, step: 'name_list_reads', error });
      return;
    }
    try {
      await syncNameList({
        stored,
        network,
        reads,
        now,
        save: async record => {
          labels.set(record.apps);
          await store.set(record);
        },
      });
      nameListSyncMetric.count({ outcome: 'ok' });
    } catch (error) {
      if (isEnvironmentFailure(error)) {
        report.expected(error, { step: 'sync', metric: nameListSyncMetric });
      } else {
        report.defect(error, { step: 'sync', metric: nameListSyncMetric, message: '[dot.li name-list] sync failed:' });
      }
    } finally {
      reads.release();
    }
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
    dotns: getActiveServicesConfig().dotns,
    source: hasLightClient(settings.backend) ? 'light-client' : 'rpc-gateway',
  });
}

function isEnvironmentFailure(error: unknown): boolean {
  const name = getErrorName(error);
  return (
    isApiStoppedError(error) || isChainHaltedRpcError(error) || (name !== undefined && EXPECTED_FAILURE_NAMES.has(name))
  );
}
