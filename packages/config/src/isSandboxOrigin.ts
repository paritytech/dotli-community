// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN } from './baseDomain.js';
import { getHostPlace } from './getHostPlace.js';
import { getLocalRoot } from './getLocalRoot.js';

/**
 * Whether `origin` is a sandbox origin, so only the embedded sandbox and not an arbitrary frame drives host services.
 */
export function isSandboxOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }
  const { hostname, protocol } = new URL(origin);
  const root = getLocalRoot(hostname);
  // A sandbox is served only on a product's own `<label>.app.<root>`, never on `app.<root>` itself, which serves the
  // shell.
  if (root !== null) {
    return getHostPlace(hostname, root) === 'app' && hostname !== `app.${root}`;
  }
  return protocol === 'https:' && hostname.endsWith(`.app.${BASE_DOMAIN}`);
}
