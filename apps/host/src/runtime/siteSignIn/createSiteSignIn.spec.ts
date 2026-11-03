// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant, type SiteGrantStore } from '@dotli/storage';
import { createMemorySiteGrantsIdb } from '@dotli/storage/testing';
import type { MainAccount } from './createMainAccountSource.js';
import type { SiteRequest } from './parseSiteRequest.js';
import type { SiteScreen } from './createSiteRound.js';
import { createSiteSignIn, getSiteSignInAction } from './createSiteSignIn.js';
import { createRecordingResponder } from '../sessionHandoff/createResponder.fake.js';
import { consentAndStore } from '../../testing/consentAndStore.js';
import { createGrant } from '../../testing/createGrant.js';
import { getResult } from '../../testing/getResult.js';
import {
  MAIN_ACCOUNT,
  MAIN_OWNER,
  NEW_SITE_TOKEN,
  ROUND_NOW,
  SITE_ORIGIN,
  SITE_TOKEN,
} from '../../testing/siteRoundConstants.js';
import { waitForView } from '../../testing/waitForView.js';
import { SITE_GROUPS } from './createSiteGroups.fake.js';

type Params = {
  /** The site's origin, {@link SITE_ORIGIN} by default. */
  origin?: string;
  siteToken?: string | null;
  groupToken?: string | null;
  /** A grants store another round shares, in place of a new one. */
  store?: SiteGrantStore;
  /** Grants the main store keeps before the round. */
  grants?: SiteGrant[];
  /** Whether saving a grant fails. */
  saveFails?: boolean;
  /** The main account the window's core reports, {@link MAIN_ACCOUNT} by default. */
  main?: MainAccount;
};

const REQUEST: SiteRequest = { round: 'r1', siteToken: null, groupToken: null };

/**
 * A site's sign-in over fakes: a responder that records what it posts and ends its round on its first terminal call, an
 * in-memory grants store, the main account the window's core reports, and a window flow the test says stored a sign-in
 * through.
 */
async function startSignIn(options: Params = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const origin = options.origin ?? SITE_ORIGIN;
  const { responder, posts } = createRecordingResponder({ origin });
  const stored = options.store ?? createSiteGrantStore({ idb: createMemorySiteGrantsIdb() });
  for (const grant of options.grants ?? []) {
    await stored.save(grant);
  }
  const grants: SiteGrantStore = {
    ...stored,
    async save(grant) {
      if (options.saveFails === true) {
        throw new Error('The grants database is full');
      }
      await stored.save(grant);
    },
  };
  const windowFlows: { stored: () => void; close: () => void }[] = [];
  const closed = createDeferred<undefined>();
  const flow = createSiteSignIn({
    request: {
      ...REQUEST,
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
    },
    origin,
    self: 'https://dot.li',
    responder,
    grants,
    groups: SITE_GROUPS,
    mainAccount: () => Promise.resolve(options.main ?? MAIN_ACCOUNT),
    startWindowFlow(storedSignIn, close) {
      windowFlows.push({ stored: storedSignIn, close });
    },
    now: () => ROUND_NOW,
    randomToken: () => NEW_SITE_TOKEN,
    close() {
      closed.resolve(undefined);
    },
  });
  const views: SiteScreen['view'][] = [flow.screen.get().view];
  onTestFinished(
    flow.screen.listen(() => {
      views.push(flow.screen.get().view);
    }),
  );
  return {
    flow,
    posts,
    stored,
    views,
    metrics,
    errors,
    closed: closed.promise,
    /** The window flow the site flow started says a sign-in is stored. */
    storeSignIn(): void {
      must(windowFlows[0], 'a started window flow').stored();
    },
    /** Resolves once the screen shows `view`. */
    waitForView: (view: SiteScreen['view']) => waitForView(flow.screen, view),
  };
}

describe('site sign-in', () => {
  it('As a user signing in to a new site, I consent and the site gets my username and a token', async () => {
    // Given a site the main store keeps no grant for, with no signer or phone in the round
    const signIn = await startSignIn();

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(signIn);
    await signIn.closed;
    const post = getResult(signIn.posts);

    // Then the site gets the main account's username alone and a new token the main store keeps
    expect(post.result).toEqual({ username: MAIN_ACCOUNT.username });
    expect(post.site_token).toBe(NEW_SITE_TOKEN);
    expect(await signIn.stored.list()).toEqual([
      { token: NEW_SITE_TOKEN, origin: SITE_ORIGIN, owner: MAIN_OWNER, firstUsedAt: ROUND_NOW, lastUsedAt: ROUND_NOW },
    ]);
    expect(signIn.views).toEqual(['site-signing', 'consent', 'window', 'site-signing']);
    expect(signIn.flow.screen.get()).toEqual({ view: 'site-signing', origin: SITE_ORIGIN, route: 'auth' });
    expect(signIn.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it('As a user with no username, I sign in to the site and it gets an empty username', async () => {
    // Given a main account with no username
    const signIn = await startSignIn({ main: { owner: MAIN_OWNER, username: null } });

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(signIn);
    await signIn.closed;
    const post = getResult(signIn.posts);

    // Then the site gets an empty username and its token, and the grant is kept
    expect(post.result).toEqual({ username: null });
    expect(post.site_token).toBe(NEW_SITE_TOKEN);
    expect(await signIn.stored.list()).toEqual([
      { token: NEW_SITE_TOKEN, origin: SITE_ORIGIN, owner: MAIN_OWNER, firstUsedAt: ROUND_NOW, lastUsedAt: ROUND_NOW },
    ]);
  });

  it('As a user signing in to a site I signed in to before, I skip consent and the site gets my username at once', async () => {
    // Given a grant for this site and this main account
    const signIn = await startSignIn({ siteToken: SITE_TOKEN, grants: [createGrant()] });

    // When the window flow says a sign-in is stored
    await signIn.waitForView('window');
    signIn.storeSignIn();
    await signIn.closed;
    const post = getResult(signIn.posts);

    // Then no consent showed, the site got its username and no new token, and the grant's last use moved on
    expect(signIn.views).not.toContain('consent');
    expect(post.result).toEqual({ username: MAIN_ACCOUNT.username });
    expect(post.site_token).toBeUndefined();
    expect(await signIn.stored.list()).toEqual([createGrant({ lastUsedAt: ROUND_NOW })]);
    expect(signIn.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'known' }]);
  });

  it('As a user with only a lite username, I sign in to the site and it gets my lite username', async () => {
    // Given a main account with only a lite username
    const signIn = await startSignIn({ main: { owner: MAIN_OWNER, username: { name: 'alice.01', kind: 'lite' } } });

    // When the round reads it
    await consentAndStore(signIn);
    await signIn.closed;

    // Then the site gets the lite username
    expect(getResult(signIn.posts).result).toEqual({ username: { name: 'alice.01', kind: 'lite' } });
  });

  it('As a site whose grant cannot be saved, I still get my result without a token and the failure is counted', async () => {
    // Given a grants store that cannot save
    const signIn = await startSignIn({ saveFails: true });

    // When the round runs
    await consentAndStore(signIn);
    await signIn.closed;
    const post = getResult(signIn.posts);

    // Then the site got its result with no token, nothing was kept, and the failed save was reported and counted
    expect(post.result).toEqual({ username: MAIN_ACCOUNT.username });
    expect(post.site_token).toBeUndefined();
    expect(await signIn.stored.list()).toEqual([]);
    expect(signIn.errors).toHaveLength(1);
    expect(signIn.views).not.toContain('site-failed');
    expect(signIn.metrics.counted('session_pages.site_sign_in')).toEqual([
      { outcome: 'error', reason: 'grant' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });
});

describe('site sign-in action', () => {
  it('As a site, I sign in and get the username of the main account the action runs for, with nothing shown or confirmed', async () => {
    // Given the sign-in action, and a round that records what the action shows or asks to confirm
    const action = getSiteSignInAction();
    const asked: string[] = [];

    // When the action runs for the main account
    const result = await action.run({
      main: MAIN_ACCOUNT,
      show(screen) {
        asked.push(screen.view);
      },
      confirmed() {
        asked.push('confirm');
        return Promise.resolve();
      },
      signal: new AbortController().signal,
    });

    // Then the result carries the main account's username alone, on the auth route, and nothing was shown or confirmed
    expect(result).toEqual({ username: MAIN_ACCOUNT.username });
    expect(asked).toEqual([]);
    expect(action.route).toBe('auth');
  });
});

describe('site sign-in of a group', () => {
  it('As a user signing in to two origins of a group, I consent once and both share one grant token', async () => {
    // Given a sign-in of one origin of the group the user consented to, whose token the other origin keeps
    const store = createSiteGrantStore({ idb: createMemorySiteGrantsIdb() });
    const first = await startSignIn({ store, groupToken: 'my group' });
    await consentAndStore(first);
    await first.closed;
    const token = must(getResult(first.posts).site_token, "the group's token");
    const second = await startSignIn({
      store,
      origin: 'https://shop.my-site.com',
      siteToken: token,
      groupToken: 'my group',
    });

    // When the other origin signs in with that token
    await second.waitForView('window');
    second.storeSignIn();
    await second.closed;
    const kept = await store.list();

    // Then the other origin got no token of its own, and the one grant of that token holds both origins, with one
    // consent and the counts of a group
    expect(getResult(second.posts).site_token).toBeUndefined();
    expect(kept.map(grant => grant.token)).toEqual([token]);
    expect(must(kept[0], 'the one grant').group?.origins).toEqual(['https://my-site.com', 'https://shop.my-site.com']);
    expect(second.views).not.toContain('consent');
    expect(second.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });
});
