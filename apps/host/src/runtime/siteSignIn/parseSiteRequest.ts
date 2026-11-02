// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A third-party site's sign-in request, read from the raw params of a session request, and the field rules every site
 * request meets. It knows no account data and no message channel.
 */

import { base64urlnopad } from '@scure/base';
import type { SessionRequest } from '../sessionHandoff/readSessionRequest.js';

export type SiteRequest = {
  round: string;
  siteToken: string | null;
  /** The site's group, which signs in once for every origin of the site's registrable domain. */
  groupToken: string | null;
};

/** The token fields every site request may carry. */
type SiteTokens = Pick<SiteRequest, 'siteToken' | 'groupToken'>;

const LINE_BREAK = /[\r\n\u2028\u2029]/;
const GROUP_TOKEN_MAX = 256;
// A lone surrogate, what `isWellFormed` rejects, read by code point so a pair never matches.
const LONE_SURROGATE = /\p{Surrogate}/u;
/** The length of a site token, in bytes. */
export const SITE_TOKEN_BYTES = 32;

/** Keys a site never sends in this stage, on any route. */
export const REFUSED_KEYS = ['intent'] as const;

/**
 * The site's sign-in request in `request`, or null when it is a bad request. Fields it does not read, such as an
 * account, a nonce or a statement, are ignored.
 */
export function parseSiteRequest(request: SessionRequest): SiteRequest | null {
  const { params } = request;
  if (REFUSED_KEYS.some(key => key in params)) {
    return null;
  }
  const tokens = readSiteTokens(params);
  if (tokens === null) {
    return null;
  }
  return { round: request.round, ...tokens };
}

/** The token fields in a site request's `params`, or null when either is present and invalid. */
export function readSiteTokens(params: Readonly<Record<string, unknown>>): SiteTokens | null {
  const siteToken = readOptionalString(params['site_token'], isSiteToken);
  const groupToken = readOptionalString(params['group_token'], isGroupToken);
  if (siteToken === undefined || groupToken === undefined) {
    return null;
  }
  return { siteToken, groupToken };
}

/** An optional string field: `null` when absent, the value when valid, `undefined` when present and invalid. */
export function readOptionalString(value: unknown, isValid: (candidate: string) => boolean): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  return typeof value === 'string' && isValid(value) ? value : undefined;
}

/** Whether `value` is a group token: one well-formed line of 1 to 256 characters. */
function isGroupToken(value: string): boolean {
  return value.length >= 1 && value.length <= GROUP_TOKEN_MAX && !LINE_BREAK.test(value) && !LONE_SURROGATE.test(value);
}

/** Whether `value` is a site token in its canonical unpadded base64url form. */
function isSiteToken(value: string): boolean {
  return decodeCanonicalBytes(value, SITE_TOKEN_BYTES) !== null;
}

/**
 * The `length` bytes `value` encodes in canonical unpadded base64url, or null when it is not that. It never throws.
 */
export function decodeCanonicalBytes(value: string, length: number): Uint8Array | null {
  try {
    const bytes = base64urlnopad.decode(value);
    // Re-encoding rejects a non-canonical final character.
    return bytes.length === length && base64urlnopad.encode(bytes) === value ? bytes : null;
  } catch {
    // A string that is not unpadded base64url is the documented bad request, not a failure to report.
    return null;
  }
}
