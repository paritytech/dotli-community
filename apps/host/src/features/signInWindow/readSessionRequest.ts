// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The request a session window reads from its URL fragment, before the hello names its party. It accepts exactly the
 * documented shape and returns null for anything else.
 */

import { isRecord } from '@dotli/shared';
import { base64urlnopad, utf8 } from '@scure/base';
import { PROTOCOL_VERSION } from './sessionMessages.js';
import type { SessionRoute } from './sessionRoute.js';

/**
 * What a session request is before its party is known: the round to answer, the version and the network as the page
 * sent them, and the raw params, whose party's own fields are parsed once the hello names the party.
 */
export type SessionRequest = {
  route: SessionRoute;
  round: string;
  /** The request's version (`v`), or null when it is not a number. */
  version: number | null;
  /** The request's network name (`net`), or null when it is not a string. */
  network: string | null;
  params: Readonly<Record<string, unknown>>;
};

type Params = {
  network: string;
  round: string;
};

/** The request `params` make on `route`, or null when they carry no round to answer. */
export function readSessionRequest(
  route: SessionRoute,
  params: Readonly<Record<string, unknown>>,
): SessionRequest | null {
  const { round, v: version, net: network } = params;
  if (typeof round !== 'string' || round === '') {
    return null;
  }
  return {
    route,
    round,
    version: typeof version === 'number' ? version : null,
    network: typeof network === 'string' ? network : null,
    params,
  };
}

/** The params every session request carries, for `round` on `network`, in this protocol version. */
export function createSessionRequestParams({ network, round }: Params): {
  v: number;
  net: string;
  round: string;
} {
  return { v: PROTOCOL_VERSION, net: network, round };
}

/**
 * The request params in a `location.hash`, with its leading `#`. `undefined` when the fragment has no `params` key, and
 * null when it has one that is not a base64url JSON object.
 */
export function readRequestParams(hash: string): Record<string, unknown> | null | undefined {
  const encoded = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('params');
  if (encoded === null) {
    return undefined;
  }
  try {
    const params: unknown = JSON.parse(utf8.encode(base64urlnopad.decode(encoded)));
    return isRecord(params) ? params : null;
  } catch {
    // Malformed base64url or JSON is the documented null outcome, not a failure to report.
    return null;
  }
}
