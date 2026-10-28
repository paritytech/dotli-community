// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readRequestParams } from './readSessionRequest.js';
import { createRequestUrl, getRoute, type SessionRoute } from './sessionRoute.js';

const ORIGIN = 'https://dot.li';

describe('session routes', () => {
  it.each<{ role: string; route: SessionRoute; params: Record<string, unknown>; prefix: string }>([
    {
      role: 'user signing in on a dot.li page',
      route: 'auth',
      // JSON whose length is not a multiple of 3, so base64 would pad it
      params: { v: 1, net: 'paseo-next-v2', round: 'r12', intent: 'signin' },
      prefix: 'https://dot.li/s/auth#params=',
    },
    {
      role: 'site asking for a transaction',
      route: 'sign',
      params: { v: 1, net: 'paseo-next-v2', round: 'r3', chain: '0x01', call: '0x0001' },
      prefix: 'https://dot.li/s/sign#params=',
    },
    {
      role: 'user signing out on a dot.li page',
      route: 'signout',
      params: { v: 1, net: 'paseo-next-v2', round: 'r2', notified: true },
      prefix: 'https://dot.li/s/signout#params=',
    },
  ])(
    'As a $role, I open the $route window and its URL lands on that route and carries my request unchanged',
    ({ route, params, prefix }) => {
      // Given my request's params on the route
      const request = { origin: ORIGIN, route, params };

      // When the URL is built and the window reads its fragment
      const url = createRequestUrl(request);
      const read = readRequestParams(new URL(url).hash);

      // Then the URL is on the route, carries no padding and reads back as the params
      expect(url.startsWith(prefix)).toBe(true);
      expect(url.split('#params=')[1]).not.toContain('=');
      expect(read).toEqual(params);
    },
  );

  it.each([
    { path: '/s/auth', route: 'auth' },
    { path: '/s/signout', route: 'signout' },
    { path: '/s/manage', route: 'manage' },
    { path: '/s/auth/', route: null },
    { path: '/s/sign', route: 'sign' },
    { path: '/s/sign/', route: null },
    { path: '/', route: null },
  ])('As a user, I open a window at $path and it finds its route, or none', ({ path, route }) => {
    // Given a window opened at the path on the session windows' origin
    const { pathname } = new URL(path, ORIGIN);

    // When the window maps its path
    const found = getRoute(pathname);

    // Then it finds the route, or none
    expect(found).toBe(route);
  });
});
