// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. How a site's transaction round through the session window went. Tagged `outcome` and `reason`: `signed` for a
 * transaction the site got signed, with `new` for a site the user granted in this round, `known` for one the main store
 * already keeps or `group` for a site of a group, new or known, `refused` with the reason the window posted, including
 * a bad request or payload the window refused before the round, `cancelled` with `page` for the window's own Cancel or
 * `phone` for a transaction the user rejected on the phone, and `error` with the step whose failure shows, with or
 * without Try again (`main_account`, `account`, `chain`, `build`, or `action` for a failure of the round that names no
 * step), with the grants store call that failed while the round went on (`grant`, `grant_read`, `grant_forget`,
 * `grant_touch`), or with `group_list` for a Public Suffix List that did not load, beside the `refused` with
 * `bad_request` of the group's request. A new grant that could not be saved counts `error` with `grant`, and the round
 * still counts `signed` with `new` or `group`, since the site gets its result without a token. A chain session that
 * could not be closed counts `error` with `chain` beside the round's outcome. `signed`, `refused` and `cancelled` count
 * once per round, `error` each time it happens.
 */
export const siteTransactionMetric = defineCount<'cancelled' | 'error' | 'refused' | 'signed'>(
  'session_pages.site_transaction',
);
