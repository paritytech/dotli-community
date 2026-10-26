// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { hostPlace, localRootOf } from '@dotli/config';
import { LOOPBACK_ROOT } from '@dotli/config/local-roots';

/** Why the window judged an opener as it did, a closed set so a count can carry it whatever the opener sent. */
export type SessionOpenerVerdict = 'allowed' | 'malformed' | 'insecure' | 'port' | 'localhost' | 'foreign' | 'app';

/**
 * How the sign-in window judges `opener` against its own origin `self`. Both must be bare origins whose hostname has no
 * trailing dot. In production the opener is https on the default port, on the root domain or a subdomain, never a
 * product origin under `app.`. Under a local root it sits under the window's own local root and shares the window's
 * protocol and port.
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

// A hostname with a trailing dot names the same host as the one without it, which the rule would read as another site,
// so such an origin is malformed.
function parseOrigin(value: string): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return url.origin === value && !url.hostname.endsWith('.') ? url : null;
}

/**
 * Who opened the window: dot.li's own page (`first`), a site (`third`), or an origin of no party, refused with the
 * verdict that says why.
 */
export type OpenerParty =
  { party: 'first' } | { party: 'third' } | { party: null; verdict: Exclude<SessionOpenerVerdict, 'allowed'> };

/**
 * The party of `opener` against the window's own origin `self`. A site is any https origin off the window's root
 * domain and its local root, on any port, or a localhost page on any port other than the window itself. A product's
 * sandbox under the window's own root domain or local root is never a site, and a page under that root on another
 * protocol or port is refused.
 */
export function openerParty(opener: string, self: string): OpenerParty {
  const verdict = sessionOpenerVerdict(opener, self);
  if (verdict === 'allowed') {
    return { party: 'first' };
  }
  if (verdict === 'malformed' || verdict === 'app') {
    return { party: null, verdict };
  }
  // Both parse, since the verdict is not malformed.
  const { hostname, protocol } = new URL(opener);
  const selfHost = new URL(self).hostname;
  if (hostname === LOOPBACK_ROOT && (protocol === 'http:' || protocol === 'https:') && opener !== self) {
    return { party: 'third' };
  }
  if (protocol === 'https:' && hostPlace(hostname, localRootOf(selfHost) ?? selfHost) === 'foreign') {
    return { party: 'third' };
  }
  return { party: null, verdict };
}
