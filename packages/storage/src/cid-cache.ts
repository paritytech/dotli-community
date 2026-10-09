// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Label to CID cache, so a repeat visit renders at once while smoldot revalidates.
// Manifest records ride along as raw text, so a hit is validated by today's validator without a chain read.

import type { Network } from '@dotli/config';
import { getDb, isExpectedDbError } from './db.js';
import { m, captureException, recordExpected, spans as S } from '@dotli/metrics';
import { isValidDotLabel, log } from '@dotli/shared';

const STORE = 'cids';

/** Raw record text as read from dotNS, `null` when the record is unset. */
export interface CachedManifests {
  root: string | null;
  app: string | null;
}

interface CidEntry {
  label: string;
  /** Absent on older entries, which read as a miss. The same name can differ per network. */
  network?: Network;
  cid: string;
  /** Absent on older entries, which read as a miss. */
  manifests?: CachedManifests;
  timestamp: number;
}

export interface CachedCid {
  cid: string;
  manifests: CachedManifests;
}

export type CidCacheResult = ({ kind: 'hit' } & CachedCid) | { kind: 'miss' } | { kind: 'error'; cause: unknown };

type CacheAction = 'read' | 'write' | 'clear' | 'evict';

// One Sentry capture per action per page, since a stuck cache reports identically on every access.
const reportedActions = new Set<CacheAction>();

function report(action: CacheAction, err: unknown): void {
  const step = `cid_cache_${action}`;
  if (isExpectedDbError(err)) {
    recordExpected(err, { flow: 'storage', step });
    return;
  }
  log.error(`[dot.li cid-cache] ${action} error:`, err);
  if (reportedActions.has(action)) {
    return;
  }
  reportedActions.add(action);
  captureException(err, { flow: 'storage', step, tags: { kind: `${step}_error` } });
}

export async function getCachedCidResult(label: string, network: Network): Promise<CidCacheResult> {
  const stop = m.timer(S.CACHE_READ_LATENCY);
  try {
    const db = await getDb();
    return await new Promise<CidCacheResult>(resolve => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(label);
      req.onsuccess = () => {
        const entry = req.result as CidEntry | undefined;
        stop();
        resolve(
          entry?.manifests === undefined || entry.network !== network
            ? { kind: 'miss' }
            : { kind: 'hit', cid: entry.cid, manifests: entry.manifests },
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

/** `null` covers both a miss and a storage error. Prefer `getCachedCidResult`. */
export async function getCachedCid(label: string, network: Network): Promise<CachedCid | null> {
  const result = await getCachedCidResult(label, network);
  if (result.kind === 'error') {
    report('read', result.cause);
    return null;
  }
  return result.kind === 'hit' ? { cid: result.cid, manifests: result.manifests } : null;
}

export const RECENT_KEY = 'dotli_recent';
const MAX_RECENT = 8;

/** Drops anything that isn't a usable label. Also used by the cross-subdomain store in `@dotli/ui`. */
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

export function withRecentLabel(labels: string[], label: string): string[] {
  return [label, ...labels.filter(l => l !== label)].slice(0, MAX_RECENT);
}

/** This origin's copy. The shared store is authoritative. */
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
    // eslint-disable-next-line no-restricted-syntax -- the recent list is UI-only, so a full or missing localStorage is not worth a metric.
  } catch {
    /* the recent list is UI decoration */
  }
}

export async function setCachedCid(
  label: string,
  network: Network,
  cid: string,
  manifests: CachedManifests,
): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, 'readwrite');
    const entry: CidEntry = {
      label,
      network,
      cid,
      manifests,
      timestamp: Date.now(),
    };
    tx.objectStore(STORE).put(entry);
    stop();
  } catch (err) {
    stop();
    report('write', err);
  }
}

/** Awaits completion so a reload right after cannot abort the clear. Best-effort, failures are only logged. */
export async function clearCidCache(): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('IDB clear error'));
      };
    });
    stop();
  } catch (err) {
    stop();
    report('clear', err);
  }
}

/** Best-effort, failures are only logged. */
export async function evictCachedCid(label: string): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(label);
    stop();
  } catch (err) {
    stop();
    report('evict', err);
  }
}
