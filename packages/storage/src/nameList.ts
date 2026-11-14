// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's dotNS name list, one record per network, so a repeat visit suggests names without a chain read.

import type { Network } from '@dotli/config';
import { createCacheReporter } from './createCacheReporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { NAME_LIST_STORE as STORE } from './schema.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { waitForIdbRequest, runIdbTransaction } from '@dotli/shared';

/** A dotNS name list for one network, as the landing page last synced it. */
export type NameListRecord = {
  network: Network;
  /** Each label store read so far, in the factory's order, with how many of its entries were read. */
  stores: readonly { address: string; read: number }[];
  /** Labels whose `app.` subname has a contenthash. */
  apps: readonly string[];
  /** Labels with no app yet, each with when it was last checked, in ms since the epoch. */
  pending: readonly { label: string; checkedAt: number }[];
};

type Params = {
  /** The database the lists live in. */
  idb?: DotliIdb;
};

// Module scope is the page, so each action's fault is captured once per page.
const reportFailure: (action: 'read' | 'write', error: unknown) => void = createCacheReporter({
  cache: 'name_list',
  tag: '[dot.li name-list]',
});

/** The name list store over `idb`, the page's own by default. */
export function createNameList({ idb = pageIdb }: Params = {}) {
  async function get(network: Network): Promise<NameListRecord | null> {
    try {
      const db = await idb.connect();
      const record = unsafe_readStoredRecord<NameListRecord | undefined>(
        await waitForIdbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(network)),
      );
      return record ?? null;
    } catch (error) {
      reportFailure('read', error);
      return null;
    }
  }

  async function set(record: NameListRecord): Promise<void> {
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(STORE).put(record);
        },
      });
    } catch (error) {
      reportFailure('write', error);
    }
  }

  return {
    /** `null` covers both a miss and a storage error, which is reported here. */
    get,
    /** Resolves once the write commits. A failure, such as a full quota, is reported here. */
    set,
  };
}

export type NameList = ReturnType<typeof createNameList>;

/** The page's dotNS name list. */
export const nameList = createNameList();
