// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The session windows' routes: the path of each on the bare host, and the URLs a page opens them at. A request travels
 * in the URL fragment, so no server sees it.
 */

import { base64urlnopad, utf8 } from '@scure/base';
import { SESSION_SEGMENT } from './sessionSegment.js';

/**
 * A session window's route. `manage` lists the signed-in sites and carries no request. `sign` signs a site's
 * transaction.
 */
export type SessionRoute = 'auth' | 'signout' | 'manage' | 'sign';

type CreateRequestUrlParams = {
  /** The session windows' origin. */
  origin: string;
  route: SessionRoute;
  /** The request, which travels as base64url JSON. */
  params: Readonly<Record<string, unknown>>;
};

const ROUTE_PATHS: Readonly<Record<SessionRoute, string>> = {
  auth: `/${SESSION_SEGMENT}/auth`,
  signout: `/${SESSION_SEGMENT}/signout`,
  manage: `/${SESSION_SEGMENT}/manage`,
  sign: `/${SESSION_SEGMENT}/sign`,
};

/** The route a window path names, or null when it names none. */
export function getRoute(pathname: string): SessionRoute | null {
  // `Object.keys` types its keys as strings, and the table's keys are exactly the routes.
  for (const route of Object.keys(ROUTE_PATHS) as SessionRoute[]) {
    if (ROUTE_PATHS[route] === pathname) {
      return route;
    }
  }
  return null;
}

/** The URL of `route` on the session windows' `origin`, with no request. */
export function getRouteUrl(origin: string, route: SessionRoute): string {
  return `${origin}${ROUTE_PATHS[route]}`;
}

/** The window URL for a request. The params travel in the fragment, so no server sees them. */
export function createRequestUrl({ origin, route, params }: CreateRequestUrlParams): string {
  return `${getRouteUrl(origin, route)}#params=${base64urlnopad.encode(utf8.decode(JSON.stringify(params)))}`;
}
