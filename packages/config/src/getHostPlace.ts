// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where a host name sits under a root domain, for the checks that admit dotli's own pages and refuse its products.

import { isUnder } from './isUnder.js';

/** The root or one of its subdomains (`site`), a product under `app.` (`app`), or neither (`foreign`). */
export type HostPlace = 'site' | 'app' | 'foreign';

/** Where `hostname` sits under the root domain `root`. */
export function getHostPlace(hostname: string, root: string): HostPlace {
  if (!isUnder(hostname, root)) {
    return 'foreign';
  }
  return isUnder(hostname, `app.${root}`) ? 'app' : 'site';
}
