// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sandbox page's own framing and origin allow, before it asks the host for its contract over the handshake.

import { getLocalRoot } from '@dotli/config';

export type SandboxPage = {
  /** The page's URL. */
  href: string;
  /** Whether the page runs in a frame, as the host renders it. */
  framed: boolean;
};

/** What the page's own framing and origin say before the host contract is fetched. */
export type SandboxContract = { kind: 'topLevel'; host: string } | { kind: 'offOrigin' } | { kind: 'onOrigin' };

/**
 * Reads the page's framing and origin. A page opened as the top-level document is `topLevel`, a framed page off a
 * product subdomain is `offOrigin`, and a framed page on one is `onOrigin`, cleared to fetch its contract from the host.
 * Throws when `href` is no URL.
 */
export function readSandboxContract({ href, framed }: SandboxPage, baseDomain: string): SandboxContract {
  const url = new URL(href);
  if (!framed) {
    return { kind: 'topLevel', host: url.host };
  }
  // A bare `app.<root>` fails loudly. Only a `<label>.app.<root>` origin is cleared, since every product gets its own.
  if (!url.hostname.endsWith(`.app.${getLocalRoot(url.hostname) ?? baseDomain}`)) {
    return { kind: 'offOrigin' };
  }
  return { kind: 'onOrigin' };
}
