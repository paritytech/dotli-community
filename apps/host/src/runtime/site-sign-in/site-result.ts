// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The third-party sign-in result a site receives. It builds no first-party session result. */

import { toHex } from '@dotli/shared';

export interface SiteSignInResult {
  username: { name: string; kind: 'lite' | 'full' };
  address: string;
  public_key: string;
  assertion: { message: string; signature: string };
}

/** The result for a site, with the public key as `0x` lowercase hex. */
export function siteSignInResult(input: {
  username: SiteSignInResult['username'];
  address: string;
  publicKey: Uint8Array;
  message: string;
  signature: string;
}): SiteSignInResult {
  return {
    username: input.username,
    address: input.address,
    public_key: toHex(input.publicKey),
    assertion: { message: input.message, signature: input.signature },
  };
}
