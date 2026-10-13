// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Label to CID cache, so a repeat visit renders at once while smoldot revalidates.
// Manifest records ride along as raw text, so a hit is validated by today's validator without a chain read.

import type { Network } from '@dotli/config';
import { createCacheReporter } from './cache-reporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { idbRequest, idbTransaction } from './idb.js';
import { m, spans as S } from '@dotli/metrics';
import { isValidDotLabel } from '@dotli/resolver';

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

// Module scope is the page, so each action's fault is captured once per page.
const reportFailure: (action: CacheAction, err: unknown) => void = createCacheReporter(
  'cid_cache',
  '[dot.li cid-cache]',
);

export const RECENT_KEY = 'dotli_recent';
const MAX_RECENT = 8;

/** Drops anything that isn't a usable label. Also used by the host's cross-subdomain store. */
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

/** This origin's copy, in `storage` or the page's localStorage. The shared store is authoritative. */
export function getRecentLabels(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    return parseRecentLabels((storage ?? localStorage).getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function writeRecentLabels(labels: string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(RECENT_KEY, serializeRecentLabels(labels));
    // eslint-disable-next-line no-restricted-syntax -- the recent list is UI-only, so a full or missing localStorage is not worth a metric.
  } catch {
    /* the recent list is UI decoration */
  }
}

/** The label to CID cache over `idb`, the page's own by default. */
export function createCidCache(idb: DotliIdb = pageIdb) {
  async function getCachedCidResult(label: string, network: Network): Promise<CidCacheResult> {
    const stop = m.timer(S.CACHE_READ_LATENCY);
    try {
      const db = await idb.connect();
      const entry = (await idbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(label))) as
        CidEntry | undefined;
      stop();
      return entry?.manifests === undefined || entry.network !== network
        ? { kind: 'miss' }
        : { kind: 'hit', cid: entry.cid, manifests: entry.manifests };
    } catch (cause) {
      stop();
      return { kind: 'error', cause };
    }
  }

  /** `null` covers both a miss and a storage error. Prefer `getCachedCidResult`. */
  async function getCachedCid(label: string, network: Network): Promise<CachedCid | null> {
    const result = await getCachedCidResult(label, network);
    if (result.kind === 'error') {
      reportFailure('read', result.cause);
      return null;
    }
    return result.kind === 'hit' ? { cid: result.cid, manifests: result.manifests } : null;
  }

  async function setCachedCid(label: string, network: Network, cid: string, manifests: CachedManifests): Promise<void> {
    const stop = m.timer(S.CACHE_WRITE_LATENCY);
    try {
      const db = await idb.connect();
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
      reportFailure('write', err);
    }
  }

  /**
   * Awaits completion so a reload right after cannot abort the clear. A failure is reported here, so the caller
   * only learns from the result (false) that the cache was not cleared.
   */
  async function clearCidCache(): Promise<boolean> {
    const stop = m.timer(S.CACHE_WRITE_LATENCY);
    try {
      const db = await idb.connect();
      await idbTransaction(db, STORE, 'readwrite', tx => {
        tx.objectStore(STORE).clear();
      });
      stop();
      return true;
    } catch (err) {
      stop();
      reportFailure('clear', err);
      return false;
    }
  }

  /** Best-effort, failures are only logged. */
  async function evictCachedCid(label: string): Promise<void> {
    const stop = m.timer(S.CACHE_WRITE_LATENCY);
    try {
      const db = await idb.connect();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(label);
      stop();
    } catch (err) {
      stop();
      reportFailure('evict', err);
    }
  }

  return { getCachedCidResult, getCachedCid, setCachedCid, clearCidCache, evictCachedCid };
}

export type CidCache = ReturnType<typeof createCidCache>;

export const { getCachedCid, setCachedCid, clearCidCache, evictCachedCid }: CidCache = createCidCache();
