// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li IndexedDB-backed installed-executable cache.
//
// A cached executable is one atomic manifest/contenthash record, scoped to
// its network and executable modality. Root and executable manifests are
// retained as raw text so the current validator can gate every launch.

import type { Network } from '@dotli/config';
import { isExpectedDbError } from './db.js';
import { m, captureException, recordExpected, spans as S } from '@dotli/metrics';
import { isValidDotLabel, log } from '@dotli/shared';

const DB_NAME = 'dotli-installed-executables';
const DB_VERSION = 1;
const STORE = 'installed_executables';
let installedDbPromise: Promise<IDBDatabase> | null = null;

function getInstalledExecutableDb(): Promise<IDBDatabase> {
  if (installedDbPromise !== null) {
    return installedDbPromise;
  }
  installedDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, {
          keyPath: ['network', 'modality', 'label'],
        });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        installedDbPromise = null;
      };
      db.onclose = () => {
        installedDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      installedDbPromise = null;
      reject(request.error ?? new Error('installed executable DB open failed'));
    };
    request.onblocked = () => {
      installedDbPromise = null;
      reject(new Error('installed executable DB open blocked'));
    };
  });
  return installedDbPromise;
}

export type ExecutableModality = 'app' | 'widget' | 'worker';

/** Raw root and app manifest record text; null means the record is unset. */
export interface CachedManifests {
  root: string | null;
  app: string | null;
}

export interface InstalledExecutable {
  contenthash: string;
  executableManifest: string;
  rootManifest: string | null;
}

interface InstalledExecutableEntry extends Omit<InstalledExecutable, 'rootManifest'> {
  rootManifest?: string | null;
  label: string;
  network: Network;
  modality: ExecutableModality;
  timestamp: number;
}

export type InstalledExecutableCacheResult =
  { kind: 'hit'; executable: InstalledExecutable } | { kind: 'miss' } | { kind: 'error'; cause: unknown };

function cacheKey(
  label: string,
  network: Network,
  modality: ExecutableModality,
): [Network, ExecutableModality, string] {
  return [network, modality, label];
}

function transactionCompletion(tx: IDBTransaction, action: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error(`IDB ${action} error`));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error(`IDB ${action} aborted`));
    };
  });
}

type CacheAction = 'write' | 'clear' | 'evict';

// Sentry capture is throttled to once per action per page: a cache stuck in
// one failure reports identically on every access.
const reportedActions = new Set<CacheAction>();

function report(action: CacheAction, err: unknown): void {
  const step = `installed_executable_cache_${action}`;
  if (isExpectedDbError(err)) {
    recordExpected(err, { flow: 'storage', step });
    return;
  }
  log.error(`[dot.li installed-executable-cache] ${action} error:`, err);
  if (reportedActions.has(action)) {
    return;
  }
  reportedActions.add(action);
  captureException(err, { flow: 'storage', step, tags: { kind: `${step}_error` } });
}

export async function getCachedInstalledExecutable(
  label: string,
  network: Network,
  modality: ExecutableModality,
): Promise<InstalledExecutableCacheResult> {
  const stop = m.timer(S.CACHE_READ_LATENCY);
  try {
    const db = await getInstalledExecutableDb();
    return await new Promise<InstalledExecutableCacheResult>(resolve => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(cacheKey(label, network, modality));
      req.onsuccess = () => {
        const entry = req.result as InstalledExecutableEntry | undefined;
        stop();
        resolve(
          entry?.rootManifest === undefined
            ? { kind: 'miss' }
            : {
                kind: 'hit',
                executable: {
                  contenthash: entry.contenthash,
                  executableManifest: entry.executableManifest,
                  rootManifest: entry.rootManifest,
                },
              },
        );
      };
      req.onerror = () => {
        stop();
        resolve({
          kind: 'error',
          cause: req.error ?? new Error('IDB read error'),
        });
      };
    });
  } catch (cause) {
    stop();
    return { kind: 'error', cause };
  }
}

export const RECENT_KEY = 'dotli_recent';
const MAX_RECENT = 8;

/**
 * Decode a stored recent list, dropping anything that isn't a usable label.
 *
 * Shared with the cross-subdomain transport in `@dotli/ui/recent-labels`,
 * which holds the same list under the shared-mode store.
 */
export function parseRecentLabels(raw: string | null): string[] {
  if (raw === null || raw === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((l): l is string => typeof l === 'string' && isValidDotLabel(l)).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function serializeRecentLabels(labels: string[]): string {
  return JSON.stringify(labels.slice(0, MAX_RECENT));
}

/** Put `label` at the front of `labels`, deduplicated and length-capped. */
export function withRecentLabel(labels: string[], label: string): string[] {
  return [label, ...labels.filter(l => l !== label)].slice(0, MAX_RECENT);
}

/** Read this origin's recent list. The shared store is authoritative. */
export function getRecentLabels(): string[] {
  try {
    return parseRecentLabels(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function writeRecentLabels(labels: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, serializeRecentLabels(labels));
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable / quota exceeded when writing a UI-only "recent labels" list. Not worth a metric per page load; defaults keep working.
  } catch {
    /* non-critical. The recent list is UI decoration */
  }
}

export async function setCachedInstalledExecutable(
  label: string,
  network: Network,
  modality: ExecutableModality,
  executable: InstalledExecutable,
): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getInstalledExecutableDb();
    const tx = db.transaction(STORE, 'readwrite');
    const completed = transactionCompletion(tx, 'write');
    const entry: InstalledExecutableEntry = {
      label,
      network,
      modality,
      contenthash: executable.contenthash,
      executableManifest: executable.executableManifest,
      rootManifest: executable.rootManifest,
      timestamp: Date.now(),
    };
    tx.objectStore(STORE).put(entry);
    await completed;
    stop();
  } catch (err) {
    stop();
    report('write', err);
  }
}

/**
 * Clear every installed-executable entry.
 *
 * Used when the user turns the dotNS cache off in settings. Awaits
 * transaction completion so a reload right after cannot race the clear.
 * Best-effort: failures are logged.
 */
export async function clearInstalledExecutableCache(): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getInstalledExecutableDb();
    const tx = db.transaction(STORE, 'readwrite');
    const completed = transactionCompletion(tx, 'clear');
    tx.objectStore(STORE).clear();
    await completed;
    stop();
  } catch (err) {
    stop();
    report('clear', err);
  }
}

/** Remove one scoped installed executable. Best-effort. */
export async function evictCachedInstalledExecutable(
  label: string,
  network: Network,
  modality: ExecutableModality,
): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getInstalledExecutableDb();
    const tx = db.transaction(STORE, 'readwrite');
    const completed = transactionCompletion(tx, 'eviction');
    tx.objectStore(STORE).delete(cacheKey(label, network, modality));
    await completed;
    stop();
  } catch (err) {
    stop();
    report('evict', err);
  }
}

export type RevalidateOutcome = { kind: 'match' } | { kind: 'update'; contenthash: string } | { kind: 'cleared' };

/**
 * Reconcile freshly resolved content and both manifests against their cached copy.
 * A changed field evicts the whole record. The caller validates the replacement
 * before publishing it, never caching an unpaired contenthash.
 */
export async function reconcileInstalledExecutable(
  label: string,
  network: Network,
  modality: ExecutableModality,
  installed: InstalledExecutable,
  freshContenthash: string | null,
  freshManifests: CachedManifests,
): Promise<RevalidateOutcome> {
  if (freshContenthash === null) {
    await evictCachedInstalledExecutable(label, network, modality);
    m.count(S.CACHE_REVALIDATE_CLEARED);
    return { kind: 'cleared' };
  }
  if (
    freshContenthash === installed.contenthash &&
    freshManifests.app === installed.executableManifest &&
    freshManifests.root === installed.rootManifest
  ) {
    await setCachedInstalledExecutable(label, network, modality, installed);
    m.count(S.CACHE_REVALIDATE_MATCH);
    return { kind: 'match' };
  }
  await evictCachedInstalledExecutable(label, network, modality);
  m.count(S.CACHE_REVALIDATE_UPDATE);
  return { kind: 'update', contenthash: freshContenthash };
}
