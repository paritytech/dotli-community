// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Label to CID cache, so a repeat visit renders at once while smoldot revalidates.
// Manifest records ride along as raw text, so a hit is validated by today's validator without a chain read. The
// product's dotNS owner rides along too, so a repeat visit reads nothing.

import type { Network } from '@dotli/config';
import { createCacheReporter } from './createCacheReporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { waitForIdbRequest, runIdbTransaction } from '@dotli/shared';
import { m } from '@dotli/metrics';

const CACHE_READ_LATENCY = 'cache.read_latency';

const CACHE_WRITE_LATENCY = 'cache.write_latency';

const STORE = 'cids';

/** Raw record text as read from dotNS, `null` when the record is unset. */
export type CachedManifests = {
  root: string | null;
  app: string | null;
  /**
   * The product's dotNS owner address, `null` for a name with none. Absent when the owner was not read, so the entry
   * reads as a miss.
   */
  owner?: string | null;
};

type CidEntry = {
  label: string;
  /** Absent on older entries, which read as a miss. The same name can differ per network. */
  network?: Network;
  cid: string;
  /** Absent on older entries, which read as a miss, as does one whose manifests have no owner field. */
  manifests?: CachedManifests;
  timestamp: number;
};

export type CachedCid = {
  cid: string;
  manifests: CachedManifests;
};

type CacheAction = 'read' | 'write' | 'clear' | 'evict';

type Params = {
  /** The database the labels live in. */
  idb?: DotliIdb;
};

type SetParams = CachedCid & {
  /** The name the CID is cached under. */
  label: string;
  /** The network `cid` was resolved on, since the same name can differ per network. */
  network: Network;
};

// Module scope is the page, so each action's fault is captured once per page.
const reportFailure: (action: CacheAction, error: unknown) => void = createCacheReporter({
  cache: 'cid_cache',
  tag: '[dot.li cid-cache]',
});

/** The label to CID cache over `idb`, the page's own by default. */
export function createCidCache({ idb = pageIdb }: Params = {}) {
  /** Resolves `null` on a miss, and rejects when the storage fails. */
  async function readCachedCid(label: string, network: Network): Promise<CachedCid | null> {
    const stop = m.timer(CACHE_READ_LATENCY);
    try {
      const db = await idb.connect();
      const entry = unsafe_readStoredRecord<CidEntry | undefined>(
        await waitForIdbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(label)),
      );
      return entry?.manifests?.owner === undefined || entry.network !== network
        ? null
        : { cid: entry.cid, manifests: entry.manifests };
    } finally {
      stop();
    }
  }

  async function get(label: string, network: Network): Promise<CachedCid | null> {
    try {
      return await readCachedCid(label, network);
    } catch (error) {
      reportFailure('read', error);
      return null;
    }
  }

  async function set({ label, network, cid, manifests }: SetParams): Promise<void> {
    const stop = m.timer(CACHE_WRITE_LATENCY);
    const entry: CidEntry = { label, network, cid, manifests, timestamp: Date.now() };
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(STORE).put(entry);
        },
      });
      stop();
    } catch (error) {
      stop();
      reportFailure('write', error);
    }
  }

  async function clear(): Promise<boolean> {
    const stop = m.timer(CACHE_WRITE_LATENCY);
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(STORE).clear();
        },
      });
      stop();
      return true;
    } catch (error) {
      stop();
      reportFailure('clear', error);
      return false;
    }
  }

  async function evict(label: string): Promise<boolean> {
    const stop = m.timer(CACHE_WRITE_LATENCY);
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(STORE).delete(label);
        },
      });
      stop();
      return true;
    } catch (error) {
      stop();
      reportFailure('evict', error);
      return false;
    }
  }

  return {
    /** `null` covers both a miss and a storage error, which is reported here. */
    get,
    /** Resolves once the write commits. A failure, such as a full quota, is reported here. */
    set,
    /**
     * Awaits completion so a reload right after cannot abort the clear. A failure is reported here, so the caller
     * only learns from the result (false) that the cache was not cleared.
     */
    clear,
    /**
     * Resolves once the delete commits, so a reload right after cannot bring the label back. A failure is reported
     * here, so the caller only learns from the result (false) that the label keeps its old CID.
     */
    evict,
  };
}

export type CidCache = ReturnType<typeof createCidCache>;

/** The page's label to CID cache. */
export const cidCache = createCidCache();
