// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { must } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { dispatchRound, type Round } from './dispatchRound.js';
import type { Party } from './openerRule.js';
import { readSessionRequest } from './readSessionRequest.js';
import type { RefusalReason } from './sessionMessages.js';
import type { SessionRoute } from './sessionRoute.js';

type RoundCase = {
  role: string;
  name: string;
  route: SessionRoute;
  /** The request's params as the opener sent them, apart from its round. */
  params: Record<string, unknown>;
  party: Party;
  enabled?: readonly Network[];
};

const ENABLED: readonly Network[] = ['paseo-next-v2', 'previewnet'];
const TLD = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.TLD;
const PASEO_HUB = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].assethub.genesis;
/** The role of a user whose dot.li page opened the window. */
const PAGE_USER = 'user signing in on a dot.li page';

describe('round dispatch', () => {
  it.each<RoundCase & { reason: RefusalReason }>([
    {
      role: PAGE_USER,
      name: 'a request of version 2',
      route: 'auth',
      params: { v: 2, net: 'paseo-next-v2', intent: 'signin' },
      party: 'first',
      reason: 'unsupported_version',
    },
    {
      role: 'site',
      name: 'a request with no version on a network nobody knows, whose version is read first,',
      route: 'auth',
      params: { net: 'kusama' },
      party: 'third',
      reason: 'unsupported_version',
    },
    {
      role: PAGE_USER,
      name: 'a request on a known network this deployment does not run',
      route: 'auth',
      params: { v: 1, net: 'previewnet', intent: 'signin' },
      party: 'first',
      enabled: ['paseo-next-v2'],
      reason: 'unknown_network',
    },
    {
      role: 'site',
      name: 'a request that names no network',
      route: 'auth',
      params: { v: 1 },
      party: 'third',
      reason: 'unknown_network',
    },
    {
      role: 'site',
      name: 'a well-formed sign-out request, since a site may not sign the user out,',
      route: 'signout',
      params: { v: 1, net: 'paseo-next-v2' },
      party: 'third',
      reason: 'bad_request',
    },
    {
      role: PAGE_USER,
      name: "a site's sign-in request, which carries no intent,",
      route: 'auth',
      params: { v: 1, net: 'paseo-next-v2' },
      party: 'first',
      reason: 'bad_request',
    },
    {
      role: PAGE_USER,
      name: "a transaction request, since dot.li's own pages sign nothing there,",
      route: 'sign',
      params: { v: 1, net: 'paseo-next-v2', chain: PASEO_HUB, call: '0x0001' },
      party: 'first',
      reason: 'bad_request',
    },
    {
      role: 'site',
      name: 'a transaction request without an account',
      route: 'sign',
      params: { v: 1, net: 'paseo-next-v2', chain: PASEO_HUB },
      party: 'third',
      reason: 'bad_request',
    },
    {
      role: 'site',
      name: 'a transaction request whose account names no network TLD',
      route: 'sign',
      params: { v: 1, net: 'paseo-next-v2', chain: PASEO_HUB, account: 'myapp/0' },
      party: 'third',
      reason: 'bad_request',
    },
    {
      role: 'site',
      name: "a transaction request naming Paseo's Asset Hub on another network",
      route: 'sign',
      params: { v: 1, net: 'previewnet', chain: PASEO_HUB },
      party: 'third',
      reason: 'bad_request',
    },
    {
      role: 'site',
      name: 'a sign-in request with an intent, which only dot.li asks for,',
      route: 'auth',
      params: { v: 1, net: 'paseo-next-v2', intent: 'resume' },
      party: 'third',
      reason: 'bad_request',
    },
  ])('As a $role, I open the $route window with $name and the window refuses it as $reason', row => {
    // Given the request as the window reads it
    const request = must(readSessionRequest(row.route, { round: 'r1', ...row.params }), 'a session request');

    // When the window dispatches its round for the opener's party
    const round = dispatchRound({ request, party: row.party, enabled: row.enabled ?? ENABLED });

    // Then it refuses the request with the reason
    expect(round).toEqual({ kind: 'refuse', reason: row.reason });
  });

  it.each<RoundCase & { round: Round }>([
    {
      role: PAGE_USER,
      name: 'a first-party sign-in request',
      route: 'auth',
      params: { v: 1, net: 'previewnet', intent: 'resume' },
      party: 'first',
      round: { kind: 'first', request: { route: 'auth', network: 'previewnet', round: 'r1', intent: 'resume' } },
    },
    {
      role: 'user signing out on a dot.li page',
      name: 'a first-party sign-out request after telling the phone',
      route: 'signout',
      params: { v: 1, net: 'paseo-next-v2', notified: true },
      party: 'first',
      round: {
        kind: 'first',
        request: { route: 'signout', network: 'paseo-next-v2', round: 'r1', notified: true },
      },
    },
    {
      role: 'site',
      name: 'a sign-in request that names no account',
      route: 'auth',
      params: { v: 1, net: 'previewnet' },
      party: 'third',
      round: { kind: 'third', request: { round: 'r1', siteToken: null, groupToken: null } },
    },
    {
      role: 'site',
      name: 'a transaction request with its call in the URL',
      route: 'sign',
      params: { v: 1, net: 'paseo-next-v2', chain: PASEO_HUB, call: '0x0001', account: `myapp.${TLD}/0` },
      party: 'third',
      round: {
        kind: 'third-sign',
        request: {
          round: 'r1',
          account: { dotNsIdentifier: asProductId(`myapp.${TLD}`), derivationIndex: { tag: 'Index', value: 0 } },
          siteToken: null,
          groupToken: null,
          chain: PASEO_HUB,
          call: '0x0001',
        },
      },
    },
  ])('As a $role, I open the $route window with $name and the window takes it as my round', row => {
    // Given the request as the window reads it
    const request = must(readSessionRequest(row.route, { round: 'r1', ...row.params }), 'a session request');

    // When the window dispatches its round for the opener's party
    const round = dispatchRound({ request, party: row.party, enabled: ENABLED });

    // Then the round carries the request as read for that party
    expect(round).toEqual(row.round);
  });
});
