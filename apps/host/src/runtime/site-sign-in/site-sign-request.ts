// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A third-party site's transaction request, read from the raw params of a session request, and the rule a call meets
 * whether it comes in the request or in a payload. It knows no account data and no message channel.
 */

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import type { ProductAccountId } from '@parity/truapi';
import { hex } from '@scure/base';
import { asRecord, type SessionRequest } from '../session-handoff/session-protocol.js';
import { parseSiteAccount } from './site-account.js';
import { isGroupToken, isSiteToken, optionalString, REFUSED_KEYS } from './site-request.js';

export interface SiteSignRequest {
  round: string;
  /** The product account the site names. */
  account: ProductAccountId;
  siteToken: string | null;
  /** The site's group, whose grant a transaction of any origin of the group uses. */
  groupToken: string | null;
  /** The genesis of the request network's Asset Hub, which the request named. */
  chain: string;
  /** The call as `0x` hex, or null when it follows in a payload. */
  call: string | null;
}

const CALL_MIN_BYTES = 2;
// Far above any call a site sends, and a bound on what a payload makes the window decode.
const CALL_MAX_BYTES = 1_000_000;
const HEX_DIGITS = /^0x[0-9a-fA-F]*$/;

/** The call's bytes when `call` is `0x` hex of 2 to 1 000 000 bytes, or null. */
export function parseSiteCall(call: string): Uint8Array | null {
  const digits = call.length - 2;
  // The length is checked first, so an oversized call is never scanned.
  if (digits % 2 !== 0 || digits / 2 < CALL_MIN_BYTES || digits / 2 > CALL_MAX_BYTES || !HEX_DIGITS.test(call)) {
    return null;
  }
  return hex.decode(call.slice(2));
}

/**
 * The site's transaction request in `request` on `net`, or null when it is a bad request. Its chain must be the
 * network's Asset Hub. Unknown fields are ignored.
 */
export function parseSiteSignRequest(request: SessionRequest, net: Network): SiteSignRequest | null {
  const params = asRecord(request.params);
  if (params === null || REFUSED_KEYS.some(key => key in params)) {
    return null;
  }
  const chain = params['chain'];
  const hub = NETWORK_NAME_TO_SERVICES_CONFIG[net].assethub.genesis;
  if (typeof chain !== 'string' || chain.toLowerCase() !== hub.toLowerCase()) {
    return null;
  }
  const account = parseSiteAccount(params['account'], net);
  const call = optionalString(params['call'], value => parseSiteCall(value) !== null);
  const siteToken = optionalString(params['site_token'], isSiteToken);
  const groupToken = optionalString(params['group_token'], isGroupToken);
  if (account === null || call === undefined || siteToken === undefined || groupToken === undefined) {
    return null;
  }
  return { round: request.round, account, siteToken, groupToken, chain: hub, call };
}
