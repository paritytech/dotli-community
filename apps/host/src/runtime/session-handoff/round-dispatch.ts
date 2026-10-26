// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a session window does with its round once the hello named the opener's party: dot.li's own page gets its
// first-party request, a site its sign-in or its transaction, and anything the window cannot answer a refusal with its
// reason.

import type { Network } from '@dotli/config';
import { parseSiteRequest, type SiteRequest } from '../site-sign-in/site-request.js';
import { parseSiteSignRequest, type SiteSignRequest } from '../site-sign-in/site-sign-request.js';
import { parseWindowRequest, type WindowRequest } from './messages.js';
import { PROTOCOL_VERSION, type RefusalReason, type SessionRequest } from './session-protocol.js';

export type Round =
  | { kind: 'first'; request: WindowRequest }
  | { kind: 'third'; request: SiteRequest; net: Network }
  | { kind: 'third-sign'; request: SiteSignRequest }
  | { kind: 'refuse'; reason: RefusalReason };

/** The round `request` makes for an opener of `party`, on a deployment that runs the `enabled` networks. */
export function dispatchRound(request: SessionRequest, party: 'first' | 'third', enabled: readonly Network[]): Round {
  if (request.v !== PROTOCOL_VERSION) {
    return { kind: 'refuse', reason: 'unsupported_version' };
  }
  const net = enabled.find(name => name === request.net);
  if (net === undefined) {
    return { kind: 'refuse', reason: 'unknown_network' };
  }
  // Only dot.li's own pages end the stored session.
  if (request.route === 'signout' && party === 'third') {
    return { kind: 'refuse', reason: 'bad_request' };
  }
  if (party === 'first') {
    const parsed = parseWindowRequest(request);
    return parsed === null ? { kind: 'refuse', reason: 'bad_request' } : { kind: 'first', request: parsed };
  }
  if (request.route === 'sign') {
    const parsed = parseSiteSignRequest(request, net);
    return parsed === null ? { kind: 'refuse', reason: 'bad_request' } : { kind: 'third-sign', request: parsed };
  }
  const parsed = parseSiteRequest(request);
  return parsed === null ? { kind: 'refuse', reason: 'bad_request' } : { kind: 'third', request: parsed, net };
}
