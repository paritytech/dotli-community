// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where a host name sits under a root domain, for the checks that admit dotli's own pages and refuse its products.

import { trustedLocalRoots } from './local-roots.js';

/** The root or one of its subdomains (`site`), a product under `app.` (`app`), or neither (`foreign`). */
export type HostPlace = 'site' | 'app' | 'foreign';

/**
 * The local root `hostname` is or sits under, or `null` for a host off every local root a build of kind `dev`
 * trusts.
 */
export function localRootOf(hostname: string, dev: boolean = import.meta.env.DEV): string | null {
  return trustedLocalRoots(dev).find(root => isUnder(hostname, root)) ?? null;
}

/** Where `hostname` sits under the root domain `root`. */
export function hostPlace(hostname: string, root: string): HostPlace {
  if (!isUnder(hostname, root)) {
    return 'foreign';
  }
  return isUnder(hostname, `app.${root}`) ? 'app' : 'site';
}

/**
 * Whether `origin` is dotli's own page: the root domain or a subdomain, never a product under `app.`, and https unless
 * under a local root that a build of kind `dev` trusts, which then stands for `baseDomain`.
 */
export function isSiteOrigin(origin: string, baseDomain: string, dev: boolean = import.meta.env.DEV): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }
  const { hostname, protocol } = new URL(origin);
  const root = localRootOf(hostname, dev);
  if (root === null && protocol !== 'https:') {
    return false;
  }
  return hostPlace(hostname, root ?? baseDomain) === 'site';
}

function isUnder(hostname: string, parent: string): boolean {
  return hostname === parent || hostname.endsWith(`.${parent}`);
}
