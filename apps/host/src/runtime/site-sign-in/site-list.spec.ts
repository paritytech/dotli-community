// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { deferred, untilStatus } from '@dotli/shared';
import { recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant, type SiteGrantStore } from '@dotli/storage';
import { memorySiteGrantsIdb } from '@dotli/storage/testing';
import { createSiteList, type SiteListScreen } from './site-list.js';

function grantOf(token: string, origin: string, lastUsedAt: number): SiteGrant {
  return {
    token,
    origin,
    owner: `0x${'cd'.repeat(32)}`,
    firstUsedAt: 1000,
    lastUsedAt,
  };
}

const OLD = grantOf('token-old', 'https://old.example', 2000);
const NEWEST = grantOf('token-newest', 'https://newest.example:8443', 4000);
const MIDDLE = grantOf('token-middle', 'https://middle.example', 3000);

interface HarnessOptions {
  grants?: SiteGrant[];
  /** How many reads of the list fail before one succeeds. */
  listFailures?: number;
  /** A read of the list that has not answered yet, which the test answers. */
  listHeld?: Promise<void>;
  forgetFails?: boolean;
}

/** A site list over an in-memory grants store, whose list or forget may fail, with its metrics and error lines. */
async function harness(options: HarnessOptions = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const stored = createSiteGrantStore(memorySiteGrantsIdb());
  for (const grant of options.grants ?? []) {
    await stored.save(grant);
  }
  let listFailures = options.listFailures ?? 0;
  const grants: SiteGrantStore = {
    ...stored,
    list: async () => {
      await options.listHeld;
      if (listFailures > 0) {
        listFailures -= 1;
        throw new Error('The grants database is closed');
      }
      return stored.list();
    },
    ...(options.forgetFails === true
      ? { forget: () => Promise.reject(new Error('The grants database is closed')) }
      : {}),
  };
  const list = createSiteList({ grants });
  const until = (verdict: (screen: SiteListScreen) => boolean): Promise<void> =>
    untilStatus(
      {
        get: list.screen.get,
        subscribe: listener =>
          list.screen.subscribe(() => {
            listener(list.screen.get());
          }),
      },
      verdict,
    );
  return { list, stored, metrics, errors, until };
}

/** The tokens the list shows, in its order. */
function tokensOf(screen: SiteListScreen): string[] {
  return screen.view === 'sites' ? screen.sites.map(site => site.token) : [];
}

describe('site list', () => {
  it('As a user, I open the site list and see each site I signed in to, the most recently used first', async () => {
    // Given three grants kept out of order
    const h = await harness({ grants: [OLD, NEWEST, MIDDLE] });

    // When the list has read them
    await h.until(screen => tokensOf(screen).length === 3);

    // Then each shows its origin and uses, newest use first, and nothing of its keys
    expect(h.list.screen.get()).toEqual({
      view: 'sites',
      sites: [NEWEST, MIDDLE, OLD].map(({ token, origin, firstUsedAt, lastUsedAt }) => ({
        token,
        origin,
        firstUsedAt,
        lastUsedAt,
        group: null,
      })),
    });
  });

  it('As a user, I open the site list and see a site group by its registrable domain and every origin, never its group token', async () => {
    // Given a group grant three origins of one registrable domain used
    const origins = ['https://a.site.example', 'https://b.site.example', 'https://c.site.example:8443'];
    const grouped: SiteGrant = {
      ...grantOf('token-group', 'https://a.site.example', 3000),
      group: { registrable: 'site.example', token: 'group-secret', origins },
    };
    const h = await harness({ grants: [grouped] });

    // When the list has read it
    await h.until(screen => tokensOf(screen).length === 1);

    // Then it shows the group's registrable domain and origins, and nothing of its group token
    expect(h.list.screen.get()).toEqual({
      view: 'sites',
      sites: [
        {
          token: 'token-group',
          origin: 'https://a.site.example',
          firstUsedAt: 1000,
          lastUsedAt: 3000,
          group: { registrable: 'site.example', origins },
        },
      ],
    });
  });

  it('As a user, I revoke a site and it leaves the list and the store while the others stay', async () => {
    // Given a list of two sites
    const h = await harness({ grants: [OLD, NEWEST] });
    await h.until(screen => tokensOf(screen).length === 2);

    // When the user revokes one
    await h.list.revoke(OLD.token);

    // Then only the other is listed and kept, and the revoke was counted
    expect(tokensOf(h.list.screen.get())).toEqual([NEWEST.token]);
    expect(await h.stored.read(OLD.token)).toBeNull();
    expect(await h.stored.read(NEWEST.token)).toEqual(NEWEST);
    expect(h.metrics.counted('session_pages.site_revoke')).toEqual([{ outcome: 'revoked', reason: 'user' }]);
  });

  it('As a user, I press Revoke twice on one site and it is revoked once', async () => {
    // Given a list of one site
    const h = await harness({ grants: [OLD] });
    await h.until(screen => tokensOf(screen).length === 1);

    // When the user revokes it twice at once
    await Promise.all([h.list.revoke(OLD.token), h.list.revoke(OLD.token)]);

    // Then the list is empty and one revoke was counted
    expect(h.list.screen.get()).toEqual({ view: 'sites', sites: [] });
    expect(h.metrics.counted('session_pages.site_revoke')).toEqual([{ outcome: 'revoked', reason: 'user' }]);
  });

  it('As a user whose grants cannot be read, I am told the list could not be read', async () => {
    // Given a grants store whose list fails
    const h = await harness({ grants: [OLD], listFailures: 1 });

    // When the list has tried to read it
    await h.until(screen => screen.view === 'sites-failed');

    // Then it says the list failed, and the failure was reported and counted
    expect(h.list.screen.get()).toEqual({ view: 'sites-failed' });
    expect(h.errors).toHaveLength(1);
    expect(h.metrics.counted('session_pages.site_list')).toEqual([{ outcome: 'error', reason: 'read' }]);
    expect(h.metrics.counted('session_pages.site_revoke')).toEqual([]);
  });

  it('As a user whose list could not be read, I try again and see my sites', async () => {
    // Given a list whose first read failed
    const h = await harness({ grants: [OLD], listFailures: 1 });
    await h.until(screen => screen.view === 'sites-failed');

    // When the user tries again
    await h.list.retry();

    // Then the site is listed
    expect(tokensOf(h.list.screen.get())).toEqual([OLD.token]);
  });

  it('As a user, I open the site list before the grants are read and see it loading, never an empty list', async () => {
    // Given a grants store whose read has not answered
    const held = deferred<undefined>();
    const h = await harness({ grants: [OLD], listHeld: held.promise });

    // When the list waits for its first read
    const shown = h.list.screen.get();

    // Then it shows that it is loading
    expect(shown).toEqual({ view: 'sites-loading' });
  });

  it('As a user, I revoke a site the store cannot forget and the failure is reported while the site stays listed', async () => {
    // Given a list of one site in a store whose forget fails
    const h = await harness({ grants: [OLD], forgetFails: true });
    await h.until(screen => tokensOf(screen).length === 1);

    // When the user revokes it
    await h.list.revoke(OLD.token);

    // Then the site stays listed, the failure was reported and the revoke counted as failed
    expect(tokensOf(h.list.screen.get())).toEqual([OLD.token]);
    expect(h.errors).toHaveLength(1);
    expect(h.metrics.counted('session_pages.site_revoke')).toEqual([{ outcome: 'failed', reason: 'user' }]);
  });
});
