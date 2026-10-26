// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { must } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant, type SiteGrantStore } from './site-grants.js';
import { memorySiteGrantsIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's grants.
let store: SiteGrantStore;

beforeEach(() => {
  store = createSiteGrantStore(memorySiteGrantsIdb());
});

function grantOf(token: string, lastUsedAt: number, overrides: Partial<SiteGrant> = {}): SiteGrant {
  return {
    token,
    origin: 'https://site.example',
    owner: `0x${'cd'.repeat(32)}`,
    firstUsedAt: 1000,
    lastUsedAt,
    ...overrides,
  };
}

type GroupGrant = SiteGrant & { group: NonNullable<SiteGrant['group']> };

function groupGrantOf(token: string, origin: string, overrides: Partial<SiteGrant> = {}): GroupGrant {
  return {
    ...grantOf(token, 2000, overrides),
    origin,
    group: { registrable: 'site.example', token: 'group-a', origins: [origin] },
  };
}

describe('site grants', () => {
  it('As a user, I sign in to a site and read its grant back by token', async () => {
    // Given a saved grant
    const grant = grantOf('token-a', 2000);
    await store.save(grant);

    // When it is read by its token
    const read = await store.read('token-a');

    // Then the same grant comes back
    expect(read).toEqual(grant);
  });

  it('As a user, I read an unknown token and get nothing', async () => {
    // Given no grants

    // When an unknown token is read
    const read = await store.read('unknown');

    // Then there is no grant
    expect(read).toBeNull();
  });

  it('As a user, I sign in twice with one token and keep one grant', async () => {
    // Given a grant saved, then saved again for the same token with a later use
    await store.save(grantOf('token-a', 2000));
    await store.save(grantOf('token-a', 3000));

    // When the grants are listed
    const grants = await store.list();

    // Then there is one grant, the later one
    expect(grants).toEqual([grantOf('token-a', 3000)]);
  });

  it('As a user, I use a site again and only its last use changes', async () => {
    // Given a saved grant
    const grant = grantOf('token-a', 2000);
    await store.save(grant);

    // When it is touched
    await store.touch('token-a', 5000);

    // Then only the last use moved
    expect(await store.read('token-a')).toEqual({ ...grant, lastUsedAt: 5000 });
  });

  it('As a user, I touch an unknown token and no grant appears', async () => {
    // Given no grants

    // When an unknown token is touched
    await store.touch('unknown', 5000);

    // Then nothing was created
    expect(await store.list()).toEqual([]);
  });

  it('As a user, I list my sites and the most recently used comes first', async () => {
    // Given three grants saved out of order
    await store.save(grantOf('old', 1000));
    await store.save(grantOf('newest', 3000));
    await store.save(grantOf('middle', 2000));

    // When they are listed
    const tokens = (await store.list()).map(grant => grant.token);

    // Then the newest last use is first
    expect(tokens).toEqual(['newest', 'middle', 'old']);
  });

  it('As a user, I forget one site and the others stay', async () => {
    // Given two grants
    await store.save(grantOf('a', 1000));
    await store.save(grantOf('b', 2000));

    // When one is forgotten
    await store.forget('a');

    // Then only the other remains
    expect(must(await store.read('b'), 'the grant b').token).toBe('b');
    expect(await store.read('a')).toBeNull();
  });

  it('As a user, I forget every site and none remain', async () => {
    // Given two grants
    await store.save(grantOf('a', 1000));
    await store.save(grantOf('b', 2000));

    // When all are forgotten
    await store.forgetAll();

    // Then the list is empty
    expect(await store.list()).toEqual([]);
  });

  it('As a site, I save a group grant with none kept and it is stored', async () => {
    // Given no grants
    const grant = groupGrantOf('token-a', 'https://a.site.example');

    // When the group grant is saved
    const saved = await store.saveGroup(grant);

    // Then it comes back and is kept
    expect(saved).toEqual(grant);
    expect(await store.list()).toEqual([grant]);
  });

  it('As a site, I save a group grant its group already holds and get the kept one with my origin joined', async () => {
    // Given a group grant kept for one origin
    await store.saveGroup(groupGrantOf('token-a', 'https://a.site.example'));

    // When another origin of the group saves for the same owner
    const saved = await store.saveGroup({ ...groupGrantOf('token-b', 'https://b.site.example'), lastUsedAt: 4000 });

    // Then the kept grant comes back with the origin joined and its last use moved, and no second grant is made
    const joined: GroupGrant = {
      ...groupGrantOf('token-a', 'https://a.site.example'),
      lastUsedAt: 4000,
      group: {
        registrable: 'site.example',
        token: 'group-a',
        origins: ['https://a.site.example', 'https://b.site.example'],
      },
    };
    expect(saved).toEqual(joined);
    expect(await store.list()).toEqual([joined]);
  });

  it('As a site, I save a group grant for another owner or group token and get a grant of its own', async () => {
    // Given a group grant kept for one owner and group token
    const kept = groupGrantOf('token-a', 'https://a.site.example');
    await store.saveGroup(kept);
    const otherOwner = groupGrantOf('token-b', 'https://b.site.example', { owner: `0x${'ef'.repeat(32)}` });
    const otherToken = groupGrantOf('token-c', 'https://c.site.example');
    otherToken.group = { ...otherToken.group, token: 'group-b' };

    // When one is saved for another owner and one for another group token
    const savedOwner = await store.saveGroup(otherOwner);
    const savedToken = await store.saveGroup(otherToken);

    // Then each is a grant of its own
    expect(savedOwner).toEqual(otherOwner);
    expect(savedToken).toEqual(otherToken);
    expect((await store.list()).map(grant => grant.token).sort()).toEqual(['token-a', 'token-b', 'token-c']);
  });

  it('As a user, I consent for one group in two tabs at once and keep one grant', async () => {
    // Given one database two stores share
    const idb = memorySiteGrantsIdb();
    const first = createSiteGrantStore(idb);
    const second = createSiteGrantStore(idb);

    // When both save for the group together
    const [a, b] = await Promise.all([
      first.saveGroup(groupGrantOf('token-a', 'https://a.site.example')),
      second.saveGroup(groupGrantOf('token-b', 'https://b.site.example')),
    ]);

    // Then both got the one grant, which holds both origins
    expect(b.token).toBe(a.token);
    const grants = await first.list();
    expect(grants.map(grant => grant.token)).toEqual([a.token]);
    expect(must(grants[0], 'the one grant').group?.origins.sort()).toEqual([
      'https://a.site.example',
      'https://b.site.example',
    ]);
  });

  it('As a site, I use a group grant from a new origin twice and the origin is joined once', async () => {
    // Given a group grant kept for one origin
    await store.saveGroup(groupGrantOf('token-a', 'https://a.site.example'));

    // When it is touched twice from another origin
    await store.touch('token-a', 5000, 'https://b.site.example');
    await store.touch('token-a', 6000, 'https://b.site.example');

    // Then the origin is joined once and the last use moved
    const grant = must(await store.read('token-a'), 'the group grant');
    expect(grant.group?.origins).toEqual(['https://a.site.example', 'https://b.site.example']);
    expect(grant.lastUsedAt).toBe(6000);
  });

  it('As a site, I use a grant without a group from an origin and it gains no group', async () => {
    // Given a grant without a group
    const grant = grantOf('token-a', 2000);
    await store.save(grant);

    // When it is touched with an origin
    await store.touch('token-a', 5000, 'https://b.site.example');

    // Then only the last use moved
    expect(await store.read('token-a')).toEqual({ ...grant, lastUsedAt: 5000 });
  });

  it('As a user, I forget a group grant while a site touches it and the touch does not bring it back', async () => {
    // Given a group grant a site has read
    await store.saveGroup(groupGrantOf('token-a', 'https://a.site.example'));
    must(await store.read('token-a'), 'the group grant');

    // When the site touches it from a new origin as the user forgets it
    await Promise.all([store.touch('token-a', 5000, 'https://b.site.example'), store.forget('token-a')]);

    // Then it is forgotten
    expect(await store.read('token-a')).toBeNull();
  });
});
