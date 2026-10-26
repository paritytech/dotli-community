// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sites a user signed in to from the main store: what a session window keeps of each one.

import { siteGrantsIdb, type DotliIdb } from './db.js';
import { idbRequest, idbTransaction } from '@dotli/shared';
import { SITE_GRANTS_STORE } from './schema.js';

export interface SiteGrant {
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
}

type SiteGroup = NonNullable<SiteGrant['group']>;

export interface SiteGrantStore {
  read: (token: string) => Promise<SiteGrant | null>;
  /** Puts by token, so saving one token twice keeps one grant. */
  save: (grant: SiteGrant) => Promise<void>;
  /**
   * Keeps one grant per group and owner. Returns the kept one with the grant's origin joined and its last use set, or
   * else stores and returns the grant.
   */
  saveGroup: (grant: SiteGrant & { group: SiteGroup }) => Promise<SiteGrant>;
  /** Sets the last use, joins `origin` to a group grant, and does nothing for an unknown token. */
  touch: (token: string, at: number, origin?: string) => Promise<void>;
  /** Newest last use first. */
  list: () => Promise<SiteGrant[]>;
  forget: (token: string) => Promise<void>;
  forgetAll: () => Promise<void>;
}

/** The site grants over `idb`, the grants database by default. Every write resolves on commit. */
export function createSiteGrantStore(idb: DotliIdb = siteGrantsIdb): SiteGrantStore {
  async function write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await idb.connect();
    await idbTransaction(db, SITE_GRANTS_STORE, 'readwrite', tx => {
      change(tx.objectStore(SITE_GRANTS_STORE));
    });
  }

  function joinOrigin(group: SiteGroup, origin: string): SiteGroup {
    return group.origins.includes(origin) ? group : { ...group, origins: [...group.origins, origin] };
  }

  return {
    async read(token) {
      const db = await idb.connect();
      const grant = (await idbRequest(
        db.transaction(SITE_GRANTS_STORE, 'readonly').objectStore(SITE_GRANTS_STORE).get(token),
      )) as SiteGrant | undefined;
      return grant ?? null;
    },
    async save(grant) {
      await write(store => {
        store.put(grant);
      });
    },
    // Reads and writes in one transaction, so two saves of one group started together keep one grant. A user's grants
    // are few, so the read takes them all rather than an index.
    async saveGroup(grant) {
      let saved: SiteGrant = { ...grant, group: joinOrigin(grant.group, grant.origin) };
      await write(store => {
        const req = store.getAll();
        req.onsuccess = () => {
          const kept = (req.result as SiteGrant[]).find(
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
    },
    // Reads and writes in one transaction, so a forget that commits meanwhile cannot be undone by the put.
    async touch(token, at, origin) {
      await write(store => {
        const req = store.get(token);
        req.onsuccess = () => {
          const grant = req.result as SiteGrant | undefined;
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
    },
    async list() {
      const db = await idb.connect();
      const grants = (await idbRequest(
        db.transaction(SITE_GRANTS_STORE, 'readonly').objectStore(SITE_GRANTS_STORE).getAll(),
      )) as SiteGrant[];
      return grants.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    },
    async forget(token) {
      await write(store => {
        store.delete(token);
      });
    },
    async forgetAll() {
      await write(store => {
        store.clear();
      });
    },
  };
}

/** The session windows' grants, in their own database. */
export const siteGrants: SiteGrantStore = createSiteGrantStore();
