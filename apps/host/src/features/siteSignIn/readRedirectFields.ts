// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A redirect sign-in's fields, read from the raw params of a site's sign-in request. */

import { decodeCanonicalBytes } from './parseSiteRequest.js';

/** A redirect sign-in's return address and the site's temporary key, which the window seals its answer to. */
export type RedirectFields = {
  /** The absolute address the answer goes back to in its fragment. */
  returnTo: string;
  /** The site's temporary X25519 key. */
  sitePublicKey: Uint8Array;
};

// An X25519 public key.
const REDIRECT_KEY_BYTES = 32;

/**
 * The redirect fields in a sign-in request's `params`: both when both are valid, `none` when neither is sent, and
 * `invalid` for one alone or either one invalid. The return address is absolute with no fragment, on https, or on http
 * for a localhost page. The key is 32 bytes of unpadded base64url.
 */
export function readRedirectFields(params: Readonly<Record<string, unknown>>): RedirectFields | 'none' | 'invalid' {
  const returnTo = params['return_to'];
  const encodedKey = params['pub'];
  if (returnTo === undefined && encodedKey === undefined) {
    return 'none';
  }
  const key = typeof encodedKey === 'string' ? decodeCanonicalBytes(encodedKey, REDIRECT_KEY_BYTES) : null;
  if (typeof returnTo !== 'string' || !isReturnAddress(returnTo) || key === null) {
    return 'invalid';
  }
  return { returnTo, sitePublicKey: key };
}

function isReturnAddress(value: string): boolean {
  // The fragment carries the answer, and even an empty one leaves a '#' the URL parser drops.
  if (value.includes('#') || !URL.canParse(value)) {
    return false;
  }
  const { protocol, hostname } = new URL(value);
  return protocol === 'https:' || (protocol === 'http:' && hostname === 'localhost');
}
