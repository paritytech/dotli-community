// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrantStore } from '@dotli/storage';
import { createMemorySiteGrantsIdb } from '@dotli/storage/testing';
import type { MainAccount } from './mainAccount.js';
import type { SiteRequest } from './parseSiteRequest.js';
import type { SiteActionState, SiteScreen } from './createSiteRound.js';
import { createSiteSignIn, createSiteSignInAction } from './createSiteSignIn.js';
import type { SiteSignInResult } from './createSiteSignInResult.js';
import { createRecordingResponder } from '../sessionHandoff/createResponder.fake.js';
import { consentAndStore } from '../../testing/consentAndStore.js';
import { getResult } from '../../testing/getResult.js';
import { MAIN_ACCOUNT, MAIN_OWNER, NEW_SITE_TOKEN, ROUND_NOW, SITE_ORIGIN } from '../../testing/siteRoundConstants.js';
import { waitForView } from '../../testing/waitForView.js';
import { SITE_GROUPS } from './createSiteGroups.fake.js';

type Params = {
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
function startSignIn(options: Params = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const { responder, posts } = createRecordingResponder({ origin: SITE_ORIGIN });
  const stored = createSiteGrantStore({ idb: createMemorySiteGrantsIdb() });
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
    request: REQUEST,
    origin: SITE_ORIGIN,
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
  const views: SiteScreen['view'][] = [];
  onTestFinished(
    flow.screen.subscribe(screen => {
      views.push(screen.view);
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
    const signIn = startSignIn();

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
    const signIn = startSignIn({ main: { owner: MAIN_OWNER, username: null } });

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

  it('As a site whose grant cannot be saved, I still get my result without a token and the failure is counted', async () => {
    // Given a grants store that cannot save
    const signIn = startSignIn({ saveFails: true });

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
  it('As a site, I sign in and get the username of the main account the action runs for, with nothing shown or confirmed', () => {
    // Given the sign-in action, and the states it moves through
    const action = createSiteSignInAction();
    const states: SiteActionState<SiteSignInResult>[] = [];
    onTestFinished(
      action.state.listen(state => {
        states.push(state);
      }),
    );

    // When the action starts for the main account
    action.start(MAIN_ACCOUNT);

    // Then it is done at once with the main account's username alone, on the auth route, and it showed no view to work
    // on or confirm
    expect(states).toEqual([{ kind: 'done', result: { username: MAIN_ACCOUNT.username } }]);
    expect(action.route).toBe('auth');
  });
});
