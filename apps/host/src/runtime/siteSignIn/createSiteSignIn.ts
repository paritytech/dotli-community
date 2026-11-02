// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's sign-in, the action a site's round runs on the auth route. It tells the site the main account's username
// and nothing else, and signs nothing.

import { spans as S } from '@dotli/metrics';
import { createSiteSignInResult, type SiteSignInResult } from './createSiteSignInResult.js';
import { createSiteRound, type SiteAction, type SiteRound, type SiteRoundParams } from './createSiteRound.js';

type Params = Omit<SiteRoundParams<SiteSignInResult>, 'action' | 'metric'>;

/** A site's sign-in in the session window: the site's round with the sign-in as its action. */
export function createSiteSignIn({ ...round }: Params): SiteRound {
  return createSiteRound({ ...round, action: getSiteSignInAction(), metric: S.SITE_SIGN_IN });
}

/** Resolves with the main account's username, or `null` when it has none. Never rejects. */
export function getSiteSignInAction(): SiteAction<SiteSignInResult> {
  return {
    route: 'auth',
    outcome: () => 'granted',
    run: ({ main }) => Promise.resolve(createSiteSignInResult(main.username)),
  };
}
