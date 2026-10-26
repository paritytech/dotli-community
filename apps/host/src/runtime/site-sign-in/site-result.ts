// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The third-party sign-in result a site receives. It builds no first-party session result. */

export interface SiteSignInResult {
  /** The main account's username, or null when it has none. */
  username: { name: string; kind: 'lite' | 'full' } | null;
}

/** The result for a site, which carries the username alone. */
export function siteSignInResult(username: SiteSignInResult['username']): SiteSignInResult {
  return { username };
}
