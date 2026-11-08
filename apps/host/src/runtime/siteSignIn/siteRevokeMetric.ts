// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. A Revoke the user pressed on the site list, or a sign-out whose forget of every grant failed. Tagged `outcome`
 * and `reason`: `revoked` with `user` for a grant forgotten, `failed` with `user` for one the grants store could not
 * forget, and `error` with `sign_out` for a sign-out, on a page or in the sign-out window, whose grants the store
 * could not forget, so the sites kept their tokens.
 */
export const siteRevokeMetric = defineCount<'error' | 'failed' | 'revoked'>('session_pages.site_revoke');
