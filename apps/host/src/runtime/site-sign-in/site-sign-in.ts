// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's sign-in, the action a site's round runs on the auth route. It tells the site the main account's username
// and nothing else, and signs nothing.

import { spans as S } from '@dotli/metrics';
import { siteSignInResult, type SiteSignInResult } from './site-result.js';
import { createSiteRound, type SiteAction, type SiteRound, type SiteRoundDeps } from './site-round.js';

export type SiteSignInDeps = Omit<SiteRoundDeps<SiteSignInResult>, 'action' | 'metric'>;

/** Resolves with the main account's username, or `null` when it has none. Never rejects. */
export function siteSignInAction(): SiteAction<SiteSignInResult> {
  return {
    route: 'auth',
    outcome: () => 'granted',
    run: ({ main }) => Promise.resolve(siteSignInResult(main.username)),
  };
}

/** A site's sign-in in the session window: the site's round with the sign-in as its action. */
export function createSiteSignIn(deps: SiteSignInDeps): SiteRound {
  return createSiteRound({ ...deps, action: siteSignInAction(), metric: S.SITE_SIGN_IN });
}
