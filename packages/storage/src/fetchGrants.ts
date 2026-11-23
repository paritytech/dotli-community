// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The user's lasting answers to a product's fetch of a host: one decision per product and host.

import { pageIdb, type DotliIdb } from './db.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { waitForIdbRequest, runIdbTransaction } from '@dotli/shared';
import { FETCH_GRANT_STORE } from './schema.js';

/** The user's lasting answer to a product fetching a host. */
export type FetchGrant = 'allowed' | 'denied';

/** The product and the host one decision is for. */
export type FetchGrantKey = {
  /** The product's label. */
  label: string;
  /** The host as a URL names it, with its port when the URL has one. */
  host: string;
};

type FetchGrantRecord = FetchGrantKey & { decision: FetchGrant };

type Params = {
  /** The database the decisions live in. */
  idb?: DotliIdb;
};

/**
 * The fetch grants over `idb`, the page's own by default. Every write resolves on commit, and every member rejects when
 * the database fails.
 */
export function createFetchGrantStore({ idb = pageIdb }: Params = {}) {
  async function write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: FETCH_GRANT_STORE,
      mode: 'readwrite',
      body: transaction => {
        change(transaction.objectStore(FETCH_GRANT_STORE));
      },
    });
  }

  async function read({ label, host }: FetchGrantKey): Promise<FetchGrant | null> {
    const db = await idb.connect();
    const record = unsafe_readStoredRecord<FetchGrantRecord | undefined>(
      await waitForIdbRequest(
        db.transaction(FETCH_GRANT_STORE, 'readonly').objectStore(FETCH_GRANT_STORE).get([label, host]),
      ),
    );
    return record?.decision ?? null;
  }

  async function save({ label, host }: FetchGrantKey, decision: FetchGrant): Promise<void> {
    await write(store => {
      store.put({ label, host, decision } satisfies FetchGrantRecord);
    });
  }

  async function clear({ label, host }: FetchGrantKey): Promise<void> {
    await write(store => {
      store.delete([label, host]);
    });
  }

  return {
    /** Resolves the decision saved for the product and host, or null when there is none. */
    read,
    /** Puts by product and host, so a later decision replaces an earlier one. */
    save,
    /** Removes the decision for the product and host, and does nothing when there is none. */
    clear,
  };
}

export type FetchGrantStore = ReturnType<typeof createFetchGrantStore>;

/** The products' fetch grants, in the page's database. */
export const fetchGrants = createFetchGrantStore();
