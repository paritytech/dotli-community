// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A third-party site's sign-in request, read from the raw params of a session request. It knows no account data and
 * no message channel.
 */

import type { Network } from '@dotli/config';
import type { ProductAccountId } from '@parity/truapi';
import { base64urlnopad } from '@scure/base';
import { asRecord, type SessionRequest } from '../session-handoff/session-protocol.js';
import { parseSiteAccount } from './site-account.js';

export interface SiteRequest {
  round: string;
  nonce: string;
  /** The product account the site names. */
  account: ProductAccountId;
  statement: string | null;
  siteToken: string | null;
  /** The site's group, which signs in once for every origin of the site's registrable domain. */
  groupToken: string | null;
}

const NONCE = /^[A-Za-z0-9]{8,128}$/;
const STATEMENT_MAX = 512;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const GROUP_TOKEN_MAX = 256;
// A lone surrogate, what `isWellFormed` rejects, read by code point so a pair never matches.
const LONE_SURROGATE = /\p{Surrogate}/u;
/** The length of a site token, in bytes. */
export const SITE_TOKEN_BYTES = 32;
// An X25519 public key.
const REDIRECT_KEY_BYTES = 32;

/** Keys a site never sends in this stage, on any route. */
export const REFUSED_KEYS = ['intent'] as const;

/** The site request in `request` on `net`, or null when it is a bad request. Unknown fields are ignored. */
export function parseSiteRequest(request: SessionRequest, net: Network): SiteRequest | null {
  const params = asRecord(request.params);
  if (params === null || REFUSED_KEYS.some(key => key in params)) {
    return null;
  }
  const nonce = params['nonce'];
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
    return null;
  }
  const account = parseSiteAccount(params['account'], net);
  const statement = optionalString(params['statement'], isStatement);
  const siteToken = optionalString(params['site_token'], isSiteToken);
  const groupToken = optionalString(params['group_token'], isGroupToken);
  if (account === null || statement === undefined || siteToken === undefined || groupToken === undefined) {
    return null;
  }
  return { round: request.round, nonce, account, statement, siteToken, groupToken };
}

/** An optional string field: `null` when absent, the value when valid, `undefined` when present and invalid. */
export function optionalString(value: unknown, isValid: (v: string) => boolean): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  return typeof value === 'string' && isValid(value) ? value : undefined;
}

function isStatement(value: string): boolean {
  return value.length >= 1 && value.length <= STATEMENT_MAX && !LINE_BREAK.test(value) && !value.startsWith('URI: ');
}

/** Whether `value` is a group token: one well-formed line of 1 to 256 characters. */
export function isGroupToken(value: string): boolean {
  return value.length >= 1 && value.length <= GROUP_TOKEN_MAX && !LINE_BREAK.test(value) && !LONE_SURROGATE.test(value);
}

/** Whether `value` is a site token in its canonical unpadded base64url form. */
export function isSiteToken(value: string): boolean {
  return canonicalBytes(value, SITE_TOKEN_BYTES) !== null;
}

/** The `length` bytes `value` encodes in canonical unpadded base64url, or null when it is not that. */
function canonicalBytes(value: string, length: number): Uint8Array | null {
  try {
    const bytes = base64urlnopad.decode(value);
    // Re-encoding rejects a non-canonical final character.
    return bytes.length === length && base64urlnopad.encode(bytes) === value ? bytes : null;
  } catch {
    // A string that is not unpadded base64url is the documented bad request, not a failure to report.
    return null;
  }
}

/** A redirect sign-in's return address and the site's temporary key, which the window seals its answer to. */
export interface RedirectFields {
  returnTo: string;
  pub: Uint8Array;
}

/**
 * The redirect fields in a sign-in request's `params`: both when both are valid, `none` when neither is sent, and
 * `invalid` for one alone or either one invalid. The return address is absolute with no fragment, on https, or on http
 * for a localhost page. The key is 32 bytes of unpadded base64url.
 */
export function readRedirectFields(params: Readonly<Record<string, unknown>>): RedirectFields | 'none' | 'invalid' {
  const returnTo = params['return_to'];
  const pub = params['pub'];
  if (returnTo === undefined && pub === undefined) {
    return 'none';
  }
  const key = typeof pub === 'string' ? canonicalBytes(pub, REDIRECT_KEY_BYTES) : null;
  if (typeof returnTo !== 'string' || !isReturnAddress(returnTo) || key === null) {
    return 'invalid';
  }
  return { returnTo, pub: key };
}

function isReturnAddress(value: string): boolean {
  // The fragment carries the answer, and even an empty one leaves a '#' the URL parser drops.
  if (value.includes('#') || !URL.canParse(value)) {
    return false;
  }
  const { protocol, hostname } = new URL(value);
  return protocol === 'https:' || (protocol === 'http:' && hostname === 'localhost');
}
