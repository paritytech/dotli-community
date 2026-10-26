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

export type SessionRoute = 'auth' | 'signout';

const ROUTE_PATHS: Readonly<Record<SessionRoute, string>> = {
  auth: `/${SESSION_SEGMENT}/auth`,
  signout: `/${SESSION_SEGMENT}/signout`,
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

/** The window URL for a request. The params travel in the fragment, so no server sees them. */
export function requestUrl(origin: string, route: SessionRoute, params: Readonly<Record<string, unknown>>): string {
  return `${origin}${ROUTE_PATHS[route]}#params=${base64urlnopad.encode(utf8.decode(JSON.stringify(params)))}`;
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

export interface ReadyMessage {
  type: 'dotli:s:ready';
  versions: number[];
}

export interface HelloMessage {
  type: 'dotli:s:hello';
  v: number;
  round: string;
}

export interface ResultMessage<R> {
  type: 'dotli:s:result';
  round: string;
  result: R;
}

export interface RefusedMessage {
  type: 'dotli:s:refused';
  round: string;
  reason: string;
}

/** A message the window sends its opener. */
export type PageMessage = ReadyMessage | ResultMessage<unknown> | RefusedMessage;

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
    return 'result' in r ? { type, round, result: r['result'] } : null;
  }
  const reason = r['reason'];
  return type === 'dotli:s:refused' && typeof reason === 'string' ? { type, round, reason } : null;
}
