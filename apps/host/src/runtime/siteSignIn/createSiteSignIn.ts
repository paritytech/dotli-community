// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's sign-in, the action a site's round runs on the auth route. It tells the site the main account's username
// and nothing else, and signs nothing.

import { createSiteSignInResult, type SiteSignInResult } from './createSiteSignInResult.js';
import { createSiteRound, type SiteAction, type SiteRound, type SiteRoundParams } from './createSiteRound.js';
import { SITE_ROUTE_METRICS } from './siteRouteMetrics.js';

type Params = Omit<SiteRoundParams<SiteSignInResult, 'granted'>, 'action'>;

/** A site's sign-in in the session window: the site's round with the sign-in as its action. */
export function createSiteSignIn(round: Params): SiteRound {
  return createSiteRound({ ...round, action: getSiteSignInAction() });
}

/** Resolves with the main account's username, or `null` when it has none. Never rejects. */
export function getSiteSignInAction(): SiteAction<SiteSignInResult, 'granted'> {
  return {
    route: 'auth',
    metric: SITE_ROUTE_METRICS.auth,
    outcome: () => 'granted',
    run: ({ main }) => Promise.resolve(createSiteSignInResult(main.username)),
  };
}
