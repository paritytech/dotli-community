// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN } from './baseDomain.js';
import { getHostPlace } from './getHostPlace.js';
import { getLocalRoot } from './getLocalRoot.js';

/**
 * Whether `origin` is a sandbox origin, so only the embedded sandbox and not an arbitrary frame drives host services.
 */
export function isSandboxOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const { hostname, protocol } = url;
    const root = getLocalRoot(hostname);
    if (root !== null) {
      return getHostPlace(hostname, root) === 'app';
    }
    if (protocol !== 'https:') {
      return false;
    }
    // A deployed sandbox is served only on a product's own `<label>.app.<root>`. The shell serves `app.<root>` itself,
    // so that host is never a sandbox.
    return hostname.endsWith(`.app.${BASE_DOMAIN}`);
  } catch {
    return false;
  }
}
