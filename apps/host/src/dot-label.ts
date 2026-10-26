// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, localRootOf } from '@dotli/config';
import { isValidDotLabel } from '@dotli/resolver';

/**
 * `null` for landing and sandbox origins. Validated before it reaches key derivation and origin construction, since a
 * malformed label can never be a registered name.
 */
export function parseDotLabel(hostname: string = window.location.hostname): string | null {
  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    if (hostname.endsWith(`.app.${BASE_DOMAIN}`)) {
      return null;
    }
    const label = hostname.slice(0, -(BASE_DOMAIN.length + 1));
    return isValidDotLabel(label) ? label : null;
  }

  const root = localRootOf(hostname);
  if (root !== null && hostname !== root) {
    if (hostname.endsWith(`.app.${root}`)) {
      return null;
    }
    const label = hostname.slice(0, -(root.length + 1));
    return isValidDotLabel(label) ? label : null;
  }

  return null;
}
