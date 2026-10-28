// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * dot.li's own session window requests, as a page writes them and a first-party window reads them. The parser accepts
 * exactly the documented shapes and returns null for anything else.
 */

import type { Network } from '@dotli/config';
import { isValidNetwork } from '@dotli/config/networks';
import { createSessionRequestParams, type SessionRequest } from './readSessionRequest.js';
import { PROTOCOL_VERSION } from './sessionMessages.js';

/**
 * What a round asks the window for. `resume` takes a sign-in the page knows exists elsewhere, which the window sends at
 * once when the main store holds one, and starts a new sign-in when it holds none.
 */
export type SignInIntent = (typeof SIGN_IN_INTENTS)[number];

/** What a first-party window reads from its request URL. */
export type WindowRequest =
  | { route: 'auth'; network: Network; round: string; intent: SignInIntent }
  | { route: 'signout'; network: Network; round: string; notified: boolean };

const SIGN_IN_INTENTS = ['signin', 'phrase', 'resume'] as const;

/** The first-party request `request` makes, or null when it breaks the contract. Unknown fields are ignored. */
export function parseWindowRequest(request: SessionRequest): WindowRequest | null {
  const { version, network } = request;
  if (version !== PROTOCOL_VERSION || network === null || !isValidNetwork(network)) {
    return null;
  }
  return getRouteRequest(request, network);
}

/** The params that `request` travels as, which the window reads back as the same request. */
export function createWindowRequestParams(request: WindowRequest): Readonly<Record<string, unknown>> {
  const envelope = createSessionRequestParams({ network: request.network, round: request.round });
  switch (request.route) {
    case 'auth':
      return { ...envelope, intent: request.intent };
    case 'signout':
      // A page that did not tell the phone sends no `notified` at all.
      return { ...envelope, ...(request.notified ? { notified: true } : {}) };
  }
}

/** The first-party request on the route of `request`, whose `network` is known, or null when it breaks the contract. */
function getRouteRequest(request: SessionRequest, network: Network): WindowRequest | null {
  const { route, round, params } = request;
  const { intent, notified } = params;
  switch (route) {
    case 'auth':
      return isSignInIntent(intent) ? { route, network, round, intent } : null;
    case 'signout':
      return { route, network, round, notified: notified === true };
    case 'manage':
    case 'sign':
      // The site list answers no page, and only sites send transactions, so a request on either path is none of
      // dot.li's own.
      return null;
  }
}

function isSignInIntent(value: unknown): value is SignInIntent {
  return SIGN_IN_INTENTS.some(intent => intent === value);
}
