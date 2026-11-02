// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SiteGrant } from '@dotli/storage';
import { MAIN_OWNER, ROUND_NOW, SITE_ORIGIN, SITE_TOKEN } from './siteRoundConstants.js';

/** A grant the main store keeps for the site, made by the main account, with `fields` over it. */
export function createGrant(fields: Partial<SiteGrant> = {}): SiteGrant {
  return {
    token: SITE_TOKEN,
    origin: SITE_ORIGIN,
    owner: MAIN_OWNER,
    firstUsedAt: ROUND_NOW - 1000,
    lastUsedAt: ROUND_NOW - 1000,
    ...fields,
  };
}
