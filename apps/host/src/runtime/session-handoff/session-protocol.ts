// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Version 1 of the wire protocol between a page and a session window: the route paths, the request carried in the URL
 * fragment, and the postMessage payloads with their parsers. Parsers accept exactly the documented shape and return null
 * for anything else. It knows no account data and no message channel.
 */

import { base64urlnopad, utf8 } from '@scure/base';
import { SESSION_SEGMENT } from './session-segment.js';

export const PROTOCOL_VERSION = 1;

/**
 * A session window's route. `manage` lists the signed-in sites and carries no request. `sign` signs a site's
 * transaction.
 */
export type SessionRoute = 'auth' | 'signout' | 'manage' | 'sign';

const ROUTE_PATHS: Readonly<Record<SessionRoute, string>> = {
  auth: `/${SESSION_SEGMENT}/auth`,
  signout: `/${SESSION_SEGMENT}/signout`,
  manage: `/${SESSION_SEGMENT}/manage`,
  sign: `/${SESSION_SEGMENT}/sign`,
};

/** The route a window path names, or null when it names none. */
export function routeOfPath(pathname: string): SessionRoute | null {
  for (const route of Object.keys(ROUTE_PATHS) as SessionRoute[]) {
    if (ROUTE_PATHS[route] === pathname) {
      return route;
    }
  }
  return null;
}

/** The URL of `route` on the session windows' `origin`, with no request. */
export function routeUrl(origin: string, route: SessionRoute): string {
  return `${origin}${ROUTE_PATHS[route]}`;
}

/** The window URL for a request. The params travel in the fragment, so no server sees them. */
export function requestUrl(origin: string, route: SessionRoute, params: Readonly<Record<string, unknown>>): string {
  return `${routeUrl(origin, route)}#params=${base64urlnopad.encode(utf8.decode(JSON.stringify(params)))}`;
}

/** `value` as a plain object, or null for anything else, arrays included. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
    return asRecord(JSON.parse(utf8.encode(base64urlnopad.decode(encoded))));
  } catch {
    // Malformed base64url or JSON is the documented null outcome, not a failure to report.
    return null;
  }
}

/**
 * What a session request is before its party is known: the round to answer, the version and the network as the page
 * sent them, and the raw params, whose party's own fields are parsed once the hello names the party.
 */
export type SessionRequest = {
  route: SessionRoute;
  round: string;
  /** The request's version, or null when it is not a number. */
  v: number | null;
  /** The request's network name, or null when it is not a string. */
  net: string | null;
  params: Readonly<Record<string, unknown>>;
};

/** The request `params` make on `route`, or null when they carry no round to answer. */
export function readSessionRequest(
  route: SessionRoute,
  params: Readonly<Record<string, unknown>>,
): SessionRequest | null {
  const { round, v, net } = params;
  if (typeof round !== 'string' || round === '') {
    return null;
  }
  return {
    route,
    round,
    v: typeof v === 'number' ? v : null,
    net: typeof net === 'string' ? net : null,
    params,
  };
}

/** Why a window refused a round, the closed set it ever posts. */
export type RefusalReason =
  | 'origin_not_allowed'
  | 'bad_request'
  | 'unsupported_version'
  | 'unknown_network'
  | 'declined'
  /** The wallet does not support or allow the transaction. */
  | 'transaction_invalid';

export type ReadyMessage = {
  type: 'dotli:s:ready';
  versions: number[];
};

export type HelloMessage = {
  type: 'dotli:s:hello';
  v: number;
  round: string;
};

/** A site's call too long for its request URL, sent after the hello. */
export type PayloadMessage = {
  type: 'dotli:s:payload';
  round: string;
  call: string;
};

export type ResultMessage<R> = {
  type: 'dotli:s:result';
  round: string;
  result: R;
  /** The token a site keeps to be known on its next sign-in. */
  site_token?: string;
};

export type RefusedMessage = {
  type: 'dotli:s:refused';
  round: string;
  /** A string as an opener reads it, since a window of another release may send a reason this one does not know. */
  reason: string;
};

/** The user left the round without an answer. */
export type CancelledMessage = {
  type: 'dotli:s:cancelled';
  round: string;
};

/** A message the window sends its opener. */
export type PageMessage = ReadyMessage | ResultMessage<unknown> | RefusedMessage | CancelledMessage;

/** The window's first message, naming the versions it speaks. */
export const READY: ReadyMessage = { type: 'dotli:s:ready', versions: [PROTOCOL_VERSION] };

/** The opener's message to the window, or null when `data` is not one. */
export function parseHello(data: unknown): HelloMessage | null {
  const r = asRecord(data);
  const v = r?.['v'];
  const round = r?.['round'];
  return r?.['type'] === 'dotli:s:hello' && typeof v === 'number' && typeof round === 'string'
    ? { type: 'dotli:s:hello', v, round }
    : null;
}

/** A site's payload to the window, or null when `data` is not one. */
export function parsePayload(data: unknown): PayloadMessage | null {
  const r = asRecord(data);
  const round = r?.['round'];
  const call = r?.['call'];
  return r?.['type'] === 'dotli:s:payload' && typeof round === 'string' && typeof call === 'string'
    ? { type: 'dotli:s:payload', round, call }
    : null;
}

/** The window's message to the opener, or null when `data` is not one. */
export function parsePageMessage(data: unknown): PageMessage | null {
  const r = asRecord(data);
  if (r === null) {
    return null;
  }
  const type = r['type'];
  if (type === 'dotli:s:ready') {
    const versions = r['versions'];
    return Array.isArray(versions) && versions.every(v => typeof v === 'number') ? { type, versions } : null;
  }
  const round = r['round'];
  if (typeof round !== 'string') {
    return null;
  }
  if (type === 'dotli:s:result') {
    return parseResult(r, round);
  }
  if (type === 'dotli:s:cancelled') {
    return { type, round };
  }
  const reason = r['reason'];
  return type === 'dotli:s:refused' && typeof reason === 'string' ? { type, round, reason } : null;
}

function parseResult(r: Record<string, unknown>, round: string): ResultMessage<unknown> | null {
  if (!('result' in r)) {
    return null;
  }
  const message: ResultMessage<unknown> = { type: 'dotli:s:result', round, result: r['result'] };
  if (!('site_token' in r)) {
    return message;
  }
  const siteToken = r['site_token'];
  return typeof siteToken === 'string' ? { ...message, site_token: siteToken } : null;
}
