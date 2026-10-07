// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN } from '@dotli/config';
import { isValidDotLabel } from '@dotli/shared';

/**
 * `null` for landing and sandbox origins. Validated before it reaches key derivation and origin construction, since a
 * malformed label can never be a registered name.
 */
export function parseDotLabel(): string | null {
  const hostname = window.location.hostname;

  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    if (hostname.endsWith(`.app.${BASE_DOMAIN}`)) {
      return null;
    }
    const label = hostname.slice(0, -(BASE_DOMAIN.length + 1));
    return isValidDotLabel(label) ? label : null;
  }

  if (hostname.endsWith('.localhost')) {
    if (hostname.endsWith('.app.localhost')) {
      return null;
    }
    const label = hostname.slice(0, -'.localhost'.length);
    return isValidDotLabel(label) ? label : null;
  }

  return null;
}
