// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sites a user signed in to from the main store: what a session window keeps of each one.

import { siteGrantsIdb, type DotliIdb } from './db.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { waitForIdbRequest, runIdbTransaction } from '@dotli/shared';
import { SITE_GRANTS_STORE } from './schema.js';

export type SiteGrant = {
  token: string;
  origin: string;
  /** Hex of the hash of the main account's public key, so a grant names whose it is without naming the account. */
  owner: string;
  firstUsedAt: number;
  lastUsedAt: number;
  /**
   * Set when the sites of one registrable domain share this grant under one group token. `origins` holds every origin
   * that used it, the one that made it first.
   */
  group?: { registrable: string; token: string; origins: string[] };
};

type SiteGroup = NonNullable<SiteGrant['group']>;

type Params = {
  /** The database the grants live in. */
  idb?: DotliIdb;
};

type TouchParams = {
  /** The origin that used the grant, joined to a group grant. */
  origin?: string;
};

/**
 * The site grants over `idb`, the grants database by default. Every write resolves on commit, and every member rejects
 * when the database fails.
 */
export function createSiteGrantStore({ idb = siteGrantsIdb }: Params = {}) {
  async function write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: SITE_GRANTS_STORE,
      mode: 'readwrite',
      body: transaction => {
        change(transaction.objectStore(SITE_GRANTS_STORE));
      },
    });
  }

  async function read(token: string): Promise<SiteGrant | null> {
    const db = await idb.connect();
    const grant = unsafe_readStoredRecord<SiteGrant | undefined>(
      await waitForIdbRequest(db.transaction(SITE_GRANTS_STORE, 'readonly').objectStore(SITE_GRANTS_STORE).get(token)),
    );
    return grant ?? null;
  }

  async function save(grant: SiteGrant): Promise<void> {
    await write(store => {
      store.put(grant);
    });
  }

  // Reads and writes in one transaction, so two saves of one group started together keep one grant. A user's grants
  // are few, so the read takes them all rather than an index.
  async function saveGroup(grant: SiteGrant & { group: SiteGroup }): Promise<SiteGrant> {
    let saved: SiteGrant = { ...grant, group: joinOrigin(grant.group, grant.origin) };
    await write(store => {
      const request = store.getAll();
      request.onsuccess = () => {
        const kept = request.result
          .map(stored => unsafe_readStoredRecord<SiteGrant>(stored))
          .find(
            other =>
              other.owner === grant.owner &&
              other.group?.registrable === grant.group.registrable &&
              other.group.token === grant.group.token,
          );
        if (kept?.group !== undefined) {
          saved = { ...kept, lastUsedAt: grant.lastUsedAt, group: joinOrigin(kept.group, grant.origin) };
        }
        store.put(saved);
      };
    });
    return saved;
  }

  // Reads and writes in one transaction, so a forget that commits meanwhile cannot be undone by the put.
  async function touch(token: string, at: number, { origin }: TouchParams = {}): Promise<void> {
    await write(store => {
      const request = store.get(token);
      request.onsuccess = () => {
        const grant = unsafe_readStoredRecord<SiteGrant | undefined>(request.result);
        if (grant === undefined) {
          return;
        }
        const touched: SiteGrant = { ...grant, lastUsedAt: at };
        if (origin !== undefined && grant.group !== undefined) {
          touched.group = joinOrigin(grant.group, origin);
        }
        store.put(touched);
      };
    });
  }

  async function list(): Promise<SiteGrant[]> {
    const db = await idb.connect();
    const grants = (
      await waitForIdbRequest(db.transaction(SITE_GRANTS_STORE, 'readonly').objectStore(SITE_GRANTS_STORE).getAll())
    ).map(stored => unsafe_readStoredRecord<SiteGrant>(stored));
    return grants.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async function forget(token: string): Promise<void> {
    await write(store => {
      store.delete(token);
    });
  }

  async function forgetAll(): Promise<void> {
    await write(store => {
      store.clear();
    });
  }

  return {
    /** Resolves the grant saved under `token`, or null when there is none. */
    read,
    /** Puts by token, so saving one token twice keeps one grant. */
    save,
    /**
     * Keeps one grant per group and owner. Returns the kept one with the grant's origin joined and its last use set, or
     * else stores and returns the grant.
     */
    saveGroup,
    /** Sets the last use, joins `origin` to a group grant, and does nothing for an unknown token. */
    touch,
    /** Newest last use first. */
    list,
    /** Removes the grant saved under `token`, and does nothing for an unknown token. */
    forget,
    /** Removes every grant. */
    forgetAll,
  };
}

export type SiteGrantStore = ReturnType<typeof createSiteGrantStore>;

/** The session windows' grants, in their own database. */
export const siteGrants = createSiteGrantStore();

function joinOrigin(group: SiteGroup, origin: string): SiteGroup {
  return group.origins.includes(origin) ? group : { ...group, origins: [...group.origins, origin] };
}
