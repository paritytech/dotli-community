// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The request URLs dot.li's own page opens its sign-in and sign-out windows at. */

import type { Network } from '@dotli/config';
import { createWindowRequestParams, type SignInIntent } from './parseWindowRequest.js';
import { createRequestUrl } from './sessionRoute.js';

type CreateSignInWindowUrlParams = {
  intent: SignInIntent;
  network: Network;
  round: string;
  /** The session windows' origin. */
  origin: string;
};

type CreateSignOutWindowUrlParams = Omit<CreateSignInWindowUrlParams, 'intent'> & {
  /** The page already told the phone. */
  notified: boolean;
};

/** The sign-in window's request URL on `origin`. */
export function createSignInWindowUrl({ intent, network, round, origin }: CreateSignInWindowUrlParams): string {
  const route = 'auth';
  return createRequestUrl({ origin, route, params: createWindowRequestParams({ route, network, round, intent }) });
}

/** The sign-out window's request URL on `origin`. */
export function createSignOutWindowUrl({ notified, network, round, origin }: CreateSignOutWindowUrlParams): string {
  const route = 'signout';
  return createRequestUrl({ origin, route, params: createWindowRequestParams({ route, network, round, notified }) });
}
