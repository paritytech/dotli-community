// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sites the user signed in to, as the grants the main store keeps, and Revoke, which forgets one at once. It reads
// only the grants, so it needs no opener, no handshake and no core.

import { m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import type { SiteGrant, SiteGrantStore } from '@dotli/storage';
import { reportWalletFailure } from '../wallet-failure.js';

/** What the list shows of a site: never its keys, whose grant it is nor its group token. */
export interface ListedSite {
  token: string;
  origin: string;
  firstUsedAt: number;
  lastUsedAt: number;
  /** The registrable domain and every origin of the group sharing the grant, or null for a site of no group. */
  group: { registrable: string; origins: string[] } | null;
}

/** The sites, newest use first, that the grants are being read, or that they could not be read. */
export type SiteListScreen =
  { view: 'sites-loading' } | { view: 'sites'; sites: ListedSite[] } | { view: 'sites-failed' };

export interface SiteList {
  screen: ReadableStore<SiteListScreen>;
  /** Forgets the site's grant and reads the list again. Never rejects: a failure is reported and counted. */
  revoke(token: string): Promise<void>;
  /** Reads the list again after a read failed. Never rejects. */
  retry(): Promise<void>;
}

/** A grants store call that failed, a closed set so the issue's `reason` tag stays bounded. */
type ListMiss = 'read' | 'forget';

function reportListMiss(error: unknown, reason: ListMiss): void {
  reportWalletFailure(error, { what: `site list ${reason}`, step: 'site_list', reason });
}

function listedOf({ token, origin, firstUsedAt, lastUsedAt, group }: SiteGrant): ListedSite {
  return {
    token,
    origin,
    firstUsedAt,
    lastUsedAt,
    group: group === undefined ? null : { registrable: group.registrable, origins: group.origins },
  };
}

export function createSiteList(deps: { grants: SiteGrantStore }): SiteList {
  const { grants } = deps;
  // Until the first read lands, so an empty list never shows before the grants are known.
  const screen = createSyncStore<SiteListScreen>('siteList', { view: 'sites-loading' }, { equals: shallowEqual });
  // One read or revoke at a time, so a revoke sees the list the last read left and no older read lands after it.
  const steps = createAsyncTaskPool({ poolSize: 1 });

  const read = async (): Promise<void> => {
    let kept: SiteGrant[];
    try {
      kept = await grants.list();
    } catch (error) {
      reportListMiss(error, 'read');
      m.count(S.SITE_LIST, { outcome: 'error', reason: 'read' });
      screen.set({ view: 'sites-failed' });
      return;
    }
    screen.set({ view: 'sites', sites: kept.map(listedOf) });
  };

  void steps.call(read);

  return {
    screen,
    revoke: token =>
      steps.call(async () => {
        const shown = screen.get();
        // A site already gone from the list was revoked by an earlier press.
        if (shown.view !== 'sites' || !shown.sites.some(site => site.token === token)) {
          return;
        }
        try {
          await grants.forget(token);
          m.count(S.SITE_REVOKE, { outcome: 'revoked', reason: 'user' });
        } catch (error) {
          reportListMiss(error, 'forget');
          m.count(S.SITE_REVOKE, { outcome: 'failed', reason: 'user' });
        }
        await read();
      }),
    retry: () =>
      steps.call(async () => {
        if (screen.get().view !== 'sites-failed') {
          return;
        }
        screen.set({ view: 'sites-loading' });
        await read();
      }),
  };
}
