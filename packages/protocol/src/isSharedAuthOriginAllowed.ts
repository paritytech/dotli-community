// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, isSiteOrigin } from '@dotli/config';

type Params = {
  /** Trusts local roots as the root domain. The build's kind when unset. */
  dev?: boolean;
};

/**
 * A host or landing page on the root domain or a subdomain, never a product, and https unless under a local root that a
 * build of kind `dev` trusts, which stands for the root domain.
 */
export function isSharedAuthOriginAllowed(origin: string, { dev = import.meta.env.DEV }: Params = {}): boolean {
  return isSiteOrigin(origin, BASE_DOMAIN, { dev });
}
