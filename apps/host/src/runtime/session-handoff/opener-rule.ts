// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { hostPlace, localRootOf } from '@dotli/config';

/** Why the window judged an opener as it did, a closed set so a count can carry it whatever the opener sent. */
export type SessionOpenerVerdict = 'allowed' | 'malformed' | 'insecure' | 'port' | 'localhost' | 'foreign' | 'app';

/**
 * How the sign-in window judges `opener` against its own origin `self`. Both must be bare origins. In production the
 * opener is https on the default port, on the root domain or a subdomain, never a product origin under `app.`. Under a
 * local root it sits under the window's own local root and shares the window's protocol and port.
 */
export function sessionOpenerVerdict(opener: string, self: string): SessionOpenerVerdict {
  const openerUrl = parseOrigin(opener);
  const selfUrl = parseOrigin(self);
  if (!openerUrl || !selfUrl) {
    return 'malformed';
  }
  const host = openerUrl.hostname;
  const root = localRootOf(selfUrl.hostname);
  // An opener under another local root is another site, as one off every local root is.
  if (localRootOf(host) !== root) {
    return root === null ? 'localhost' : 'foreign';
  }
  const local = root !== null;
  if (openerUrl.protocol !== (local ? selfUrl.protocol : 'https:')) {
    return 'insecure';
  }
  if (openerUrl.port !== (local ? selfUrl.port : '')) {
    return 'port';
  }
  const place = hostPlace(host, root ?? selfUrl.hostname);
  return place === 'site' ? 'allowed' : place;
}

function parseOrigin(value: string): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return url.origin === value ? url : null;
}
