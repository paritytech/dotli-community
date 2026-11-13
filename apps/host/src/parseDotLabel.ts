// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, getLocalRoot } from '@dotli/config';
import { isValidDotLabel } from '@dotli/resolver';

/**
 * `null` for landing and sandbox origins. Validated before it reaches key derivation and origin construction, since a
 * malformed label can never be a registered name.
 */
export function parseDotLabel(hostname: string): string | null {
  const root = hostname.endsWith(`.${BASE_DOMAIN}`) ? BASE_DOMAIN : getLocalRoot(hostname);
  if (root === null || hostname === root || hostname.endsWith(`.app.${root}`)) {
    return null;
  }
  const label = hostname.slice(0, -(root.length + 1));
  return isValidDotLabel(label) ? label : null;
}
