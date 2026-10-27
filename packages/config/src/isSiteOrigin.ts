// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getHostPlace } from './getHostPlace.js';
import { getLocalRoot } from './getLocalRoot.js';

type Params = {
  /** Whether the local roots a development build trusts apply. The page's own build by default. */
  dev?: boolean;
};

/**
 * Whether `origin` is dotli's own page: the root domain or a subdomain, never a product under `app.`, and https unless
 * under a local root that a build of kind `dev` trusts, which then stands for `baseDomain`.
 */
export function isSiteOrigin(origin: string, baseDomain: string, { dev = import.meta.env.DEV }: Params = {}): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }
  const { hostname, protocol } = new URL(origin);
  const root = getLocalRoot(hostname, { dev });
  if (root === null && protocol !== 'https:') {
    return false;
  }
  return getHostPlace(hostname, root ?? baseDomain) === 'site';
}
