// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. How a site's sign-in round through the session window went. Tagged `outcome` and `reason`: `granted` with
 * `new` for a site the user signed in to for the first time, `known` for one the main store already keeps or `group`
 * for a site of a group, new or known, `refused` with the reason the window posted, a site's sign-out request included,
 * or with why a redirect sign-in failed its vetting, counted though nothing is sent (`unsupported_browser` for a
 * browser without X25519, `bad_key` for a site key no secret derives with, `return_to_party` for a return address of no
 * site, `return_to_not_listed` or `well_known_unreachable` for one the site's well-known file does not list),
 * `cancelled` with `page` for the window's own Cancel or `phone` for a request the user rejected on the phone, and
 * `error` with the step whose failure shows, with or without Try again (`main_account`, `account`, `sign`, or `action`
 * for a failure of the round that names no step), with the grants store call that failed while the round went on
 * (`grant`, `grant_read`, `grant_forget`, `grant_touch`), with `group_list` for a Public Suffix List that did not load,
 * beside the `refused` with `bad_request` of the group's request, or with `seal` for a redirect answer the window could
 * not seal. A new grant that could not be saved counts `error` with `grant`, and the round still counts `granted` with
 * `new` or `group`, since the site gets its result without a token. `granted`, `refused` and `cancelled` count once per
 * round, `error` each time it happens.
 */
export const siteSignInMetric = defineCount<'cancelled' | 'error' | 'granted' | 'refused'>(
  'session_pages.site_sign_in',
);
