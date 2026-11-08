// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CountMetric } from '@dotli/metrics';
import type { SessionRoute } from '../sessionHandoff/sessionRoute.js';
import { siteSignInMetric } from './siteSignInMetric.js';
import { siteTransactionMetric } from './siteTransactionMetric.js';

/** The routes a site's round runs on: its sign-in and its transaction. */
export type SiteRoute = Extract<SessionRoute, 'auth' | 'sign'>;

/** The words a round counts whatever its route. */
export type SiteRoundWord = 'refused' | 'cancelled' | 'error';

/** The metric each site route counts on, a refusal before its round starts included. */
export const SITE_ROUTE_METRICS = {
  auth: siteSignInMetric,
  sign: siteTransactionMetric,
} satisfies Record<SiteRoute, CountMetric<SiteRoundWord>>;
