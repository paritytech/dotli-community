// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { must } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { parseWindowRequest } from './parseWindowRequest.js';
import { readSessionRequest } from './readSessionRequest.js';
import type { SessionRoute } from './sessionRoute.js';

describe('window requests', () => {
  it('As a user signing out, I open the sign-out window with a notified other than true and it reads as false', () => {
    // Given a sign-out request whose notified is a string, read as the window reads any request first
    const params = { v: 1, net: 'paseo-next-v2', round: 'r', notified: 'true' };
    const request = must(readSessionRequest('signout', params), 'a session request');

    // When it is parsed
    const parsed = parseWindowRequest(request);

    // Then it reads as false
    expect(parsed).toEqual({ route: 'signout', network: 'paseo-next-v2', round: 'r', notified: false });
  });

  it.each<{ name: string; route: SessionRoute; params: Record<string, unknown> }>([
    { name: 'another v', route: 'auth', params: { v: 2, net: 'paseo-next-v2', round: 'r', intent: 'signin' } },
    { name: 'no v', route: 'auth', params: { net: 'paseo-next-v2', round: 'r', intent: 'signin' } },
    { name: 'an unknown network', route: 'auth', params: { v: 1, net: 'nope', round: 'r', intent: 'signin' } },
    {
      name: 'an unknown intent',
      route: 'auth',
      params: { v: 1, net: 'paseo-next-v2', round: 'r', intent: 'signout' },
    },
    { name: 'a missing intent', route: 'auth', params: { v: 1, net: 'paseo-next-v2', round: 'r' } },
    // A sign-in request on the sign route, which would read as a sign-in elsewhere
    {
      name: "a request none of dot.li's own pages sends there",
      route: 'sign',
      params: { v: 1, net: 'paseo-next-v2', round: 'r', intent: 'signin' },
    },
    { name: 'another v', route: 'signout', params: { v: 2, net: 'paseo-next-v2', round: 'r' } },
  ])('As a user, I open the $route window with $name and the request reads as null', ({ route, params }) => {
    // Given a request that breaks the contract, read as the window reads any request first
    const request = must(readSessionRequest(route, params), 'a session request');

    // When the window parses it
    const parsed = parseWindowRequest(request);

    // Then it is null
    expect(parsed).toBeNull();
  });

  it('As a user signing in, I open the sign-in window with a field it does not know and the request reads as without it', () => {
    // Given a request and the same with an extra field
    const base = { v: 1, net: 'paseo-next-v2', round: 'r', intent: 'signin' };
    const plain = must(readSessionRequest('auth', base), 'a session request');
    const extended = must(readSessionRequest('auth', { ...base, site_token: 'x' }), 'a session request');

    // When both are parsed
    const withoutExtra = parseWindowRequest(plain);
    const withExtra = parseWindowRequest(extended);

    // Then the extra field changes nothing
    expect(withExtra).toEqual(withoutExtra);
    expect(withExtra).not.toBeNull();
  });
});
