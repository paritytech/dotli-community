// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's sign-in, the action a site's round runs on the auth route. It tells the site the main account's username
// and nothing else, and signs nothing.

import { atom } from 'nanostores';
import { noop } from '@dotli/shared';
import { createSiteSignInResult, type SiteSignInResult } from './createSiteSignInResult.js';
import {
  createSiteRound,
  type SiteAction,
  type SiteActionState,
  type SiteRound,
  type SiteRoundParams,
} from './createSiteRound.js';
import { SITE_ROUTE_METRICS } from './siteRouteMetrics.js';

type Params = Omit<SiteRoundParams<SiteSignInResult, 'granted'>, 'action'>;

/** A site's sign-in in the session window: the site's round with the sign-in as its action. */
export function createSiteSignIn(round: Params): SiteRound {
  return createSiteRound({ ...round, action: createSiteSignInAction() });
}

/**
 * The sign-in action, done at once on its start with the main account's username, or `null` when it has none. It has
 * two phases and no async work, so a plain atom holds them.
 */
export function createSiteSignInAction(): SiteAction<SiteSignInResult, 'granted'> {
  const state = atom<SiteActionState<SiteSignInResult>>({ kind: 'idle' });
  return {
    route: 'auth',
    metric: SITE_ROUTE_METRICS.auth,
    outcome: () => 'granted',
    state,
    prepare: noop,
    start(main) {
      if (state.get().kind !== 'idle') {
        return;
      }
      state.set({ kind: 'done', result: createSiteSignInResult(main.username) });
    },
    confirm: noop,
    end: noop,
    await: () => Promise.resolve(),
  };
}
