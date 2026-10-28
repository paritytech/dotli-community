// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a session window does with its round once the hello named the opener's party: dot.li's own page gets its
// first-party request, a site its sign-in or its transaction, and anything the window cannot answer a refusal with its
// reason.

import type { Network } from '@dotli/config';
import { parseSiteRequest, type SiteRequest } from '../siteSignIn/parseSiteRequest.js';
import { parseSiteSignRequest, type SiteSignRequest } from '../siteSignIn/parseSiteSignRequest.js';
import { parseWindowRequest, type WindowRequest } from './parseWindowRequest.js';
import type { Party } from './openerRule.js';
import type { SessionRequest } from './readSessionRequest.js';
import { PROTOCOL_VERSION, type RefusalReason } from './sessionMessages.js';

/** What the window runs for a round: the request of the opener's party, or a refusal with its reason. */
export type Round =
  | { kind: 'first'; request: WindowRequest }
  | { kind: 'third'; request: SiteRequest }
  | { kind: 'third-sign'; request: SiteSignRequest }
  | { kind: 'refuse'; reason: RefusalReason };

type Params = {
  request: SessionRequest;
  /** The party of the opener's vetted origin. */
  party: Party;
  /** The networks this deployment runs. */
  enabled: readonly Network[];
};

const BAD_REQUEST: Round = { kind: 'refuse', reason: 'bad_request' };

/** The round `request` makes for an opener of `party`, on a deployment that runs the `enabled` networks. */
export function dispatchRound({ request, party, enabled }: Params): Round {
  if (request.version !== PROTOCOL_VERSION) {
    return { kind: 'refuse', reason: 'unsupported_version' };
  }
  const network = enabled.find(name => name === request.network);
  if (network === undefined) {
    return { kind: 'refuse', reason: 'unknown_network' };
  }
  switch (party) {
    case 'first':
      return getFirstPartyRound(request);
    case 'third':
      return getThirdPartyRound(request, network);
  }
}

function getFirstPartyRound(request: SessionRequest): Round {
  const parsed = parseWindowRequest(request);
  return parsed === null ? BAD_REQUEST : { kind: 'first', request: parsed };
}

function getThirdPartyRound(request: SessionRequest, network: Network): Round {
  switch (request.route) {
    case 'signout':
      // Only dot.li's own pages end the stored session.
      return BAD_REQUEST;
    case 'sign': {
      const parsed = parseSiteSignRequest(request, network);
      return parsed === null ? BAD_REQUEST : { kind: 'third-sign', request: parsed };
    }
    case 'auth':
    case 'manage': {
      const parsed = parseSiteRequest(request);
      return parsed === null ? BAD_REQUEST : { kind: 'third', request: parsed };
    }
  }
}
