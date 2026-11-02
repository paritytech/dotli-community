// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { must } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { createSignInWindowUrl, createSignOutWindowUrl } from './createSignInWindowUrl.js';
import { parseWindowRequest } from './parseWindowRequest.js';
import { readRequestParams, readSessionRequest } from './readSessionRequest.js';
import { getRoute } from './sessionRoute.js';

/** The params a window reads from a request URL's fragment. */
function readUrlParams(url: string) {
  return must(readRequestParams(new URL(url).hash), 'request params');
}

/** The first-party request a window reads from `url`, on the route its path names. */
function readWindowRequest(url: string) {
  const route = must(getRoute(new URL(url).pathname), 'a session route');
  return parseWindowRequest(must(readSessionRequest(route, readUrlParams(url)), 'a session request'));
}

describe('window request URLs', () => {
  it('As a user signing in on a dot.li page, I open the sign-in window at its URL and the window reads it back as my request', () => {
    // Given a sign-in request for the phrase window
    const request = { intent: 'phrase', network: 'paseo-next-v2', round: 'r1', origin: 'https://dot.li' } as const;

    // When the page builds the window's URL and the window reads it
    const url = createSignInWindowUrl(request);
    const read = readWindowRequest(url);

    // Then the URL is on the sign-in route and reads back as my request
    expect(read).toEqual({ route: 'auth', network: 'paseo-next-v2', round: 'r1', intent: 'phrase' });
    expect(url.startsWith('https://dot.li/s/auth#params=')).toBe(true);
  });

  it('As a user signing out on a dot.li page, I open the sign-out window and its URL carries notified only when I told the phone', () => {
    // Given a sign-out request on the session windows' origin
    const request = { network: 'paseo-next-v2', round: 'r2', origin: 'https://dot.li' } as const;

    // When the page builds the URL after telling the phone and without, and the window reads both
    const toldUrl = createSignOutWindowUrl({ ...request, notified: true });
    const untoldUrl = createSignOutWindowUrl({ ...request, notified: false });
    const told = readWindowRequest(toldUrl);
    const untoldParams = readUrlParams(untoldUrl);
    const untold = readWindowRequest(untoldUrl);

    // Then notified travels only when true
    expect(told).toEqual({ route: 'signout', network: 'paseo-next-v2', round: 'r2', notified: true });
    expect(untoldParams).not.toHaveProperty('notified');
    expect(untold).toEqual({ route: 'signout', network: 'paseo-next-v2', round: 'r2', notified: false });
  });
});
