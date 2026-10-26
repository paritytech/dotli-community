// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { describe, expect, it } from 'vitest';
import { dispatchRound } from './round-dispatch.js';
import type { SessionRequest, SessionRoute } from './session-protocol.js';

const ENABLED: readonly Network[] = ['paseo-next-v2', 'previewnet'];
const PASEO_HUB = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].assethub.genesis;

/** A request on `route` with `params` as the page sent them. */
function requestOf(route: SessionRoute, params: Record<string, unknown>): SessionRequest {
  const { v, net } = params;
  return {
    route,
    round: 'r1',
    v: typeof v === 'number' ? v : null,
    net: typeof net === 'string' ? net : null,
    params: { round: 'r1', ...params },
  };
}

describe('round dispatch', () => {
  it('As a session window, I get a request of another version and refuse it as unsupported', () => {
    // Given a request of version 2
    const request = requestOf('auth', { v: 2, net: 'paseo-next-v2', intent: 'signin' });

    // When the window dispatches its round for dot.li's own page
    const round = dispatchRound(request, 'first', ENABLED);

    // Then it refuses the version
    expect(round).toEqual({ kind: 'refuse', reason: 'unsupported_version' });
  });

  it('As a session window, I get a request with no version and refuse it as unsupported before reading its network', () => {
    // Given a request with no version on a network nobody knows
    const request = requestOf('auth', { net: 'kusama', nonce: 'abcdefgh' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then the version is what it refuses
    expect(round).toEqual({ kind: 'refuse', reason: 'unsupported_version' });
  });

  it('As a session window, I get a request on a network this deployment does not run and refuse it as unknown', () => {
    // Given a request on a known network that is not enabled here
    const request = requestOf('auth', { v: 1, net: 'previewnet', intent: 'signin' });

    // When the window dispatches its round with only Paseo enabled
    const round = dispatchRound(request, 'first', ['paseo-next-v2']);

    // Then it refuses the network
    expect(round).toEqual({ kind: 'refuse', reason: 'unknown_network' });
  });

  it('As a session window, I get a request with no network and refuse it as unknown', () => {
    // Given a site's request that names no network
    const request = requestOf('auth', { v: 1, nonce: 'abcdefgh' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then it refuses the network
    expect(round).toEqual({ kind: 'refuse', reason: 'unknown_network' });
  });

  it('As a session window opened by a site on the sign-out path, I refuse the round as a bad request', () => {
    // Given a well-formed sign-out request
    const request = requestOf('signout', { v: 1, net: 'paseo-next-v2' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then a site may not sign the user out
    expect(round).toEqual({ kind: 'refuse', reason: 'bad_request' });
  });

  it("As a sign-in window opened by dot.li's own page, I get its request as a first-party round", () => {
    // Given a first-party sign-in request
    const request = requestOf('auth', { v: 1, net: 'previewnet', intent: 'resume' });

    // When the window dispatches its round for dot.li's own page
    const round = dispatchRound(request, 'first', ENABLED);

    // Then the round carries the first-party request
    expect(round).toEqual({
      kind: 'first',
      request: { route: 'auth', net: 'previewnet', round: 'r1', intent: 'resume' },
    });
  });

  it("As a sign-out window opened by dot.li's own page, I get its request as a first-party round", () => {
    // Given a first-party sign-out request from a page that told the phone
    const request = requestOf('signout', { v: 1, net: 'paseo-next-v2', notified: true });

    // When the window dispatches its round for dot.li's own page
    const round = dispatchRound(request, 'first', ENABLED);

    // Then the round carries the first-party request
    expect(round).toEqual({
      kind: 'first',
      request: { route: 'signout', net: 'paseo-next-v2', round: 'r1', notified: true },
    });
  });

  it("As a sign-in window opened by dot.li's own page, I get a site's request and refuse it as a bad request", () => {
    // Given a request with a nonce and no intent
    const request = requestOf('auth', { v: 1, net: 'paseo-next-v2', nonce: 'abcdefgh' });

    // When the window dispatches its round for dot.li's own page
    const round = dispatchRound(request, 'first', ENABLED);

    // Then the first party's request does not parse
    expect(round).toEqual({ kind: 'refuse', reason: 'bad_request' });
  });

  it('As a sign-in window opened by a site, I get its request as a third-party round on its network', () => {
    // Given a site's sign-in request with words of its own
    const request = requestOf('auth', { v: 1, net: 'previewnet', nonce: 'abcdefgh', statement: 'Keep your playlists' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then the round carries the site's request as read and the network it names
    expect(round).toEqual({
      kind: 'third',
      request: { round: 'r1', nonce: 'abcdefgh', statement: 'Keep your playlists', siteToken: null, groupToken: null },
      net: 'previewnet',
    });
  });

  it('As a sign-in window opened by a site, I get a request with a bad nonce and refuse it as a bad request', () => {
    // Given a site's sign-in request whose nonce is too short
    const request = requestOf('auth', { v: 1, net: 'previewnet', nonce: 'abc' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then the site's request does not parse
    expect(round).toEqual({ kind: 'refuse', reason: 'bad_request' });
  });

  it("As a sign window opened by dot.li's own page, I refuse its request as a bad request", () => {
    // Given a well-formed transaction request
    const request = requestOf('sign', { v: 1, net: 'paseo-next-v2', chain: PASEO_HUB, call: '0x0001' });

    // When the window dispatches its round for dot.li's own page
    const round = dispatchRound(request, 'first', ENABLED);

    // Then dot.li's own pages sign nothing there
    expect(round).toEqual({ kind: 'refuse', reason: 'bad_request' });
  });

  it("As a sign window opened by a site, I get its transaction request as a site's sign round", () => {
    // Given a site's transaction request with its call in the URL
    const request = requestOf('sign', { v: 1, net: 'paseo-next-v2', chain: PASEO_HUB, call: '0x0001' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then the round carries the site's request as read, whose network the window boots on
    expect(round).toEqual({
      kind: 'third-sign',
      request: { round: 'r1', siteToken: null, groupToken: null, chain: PASEO_HUB, call: '0x0001' },
    });
  });

  it("As a sign window opened by a site, I get a request for another network's chain and refuse it as a bad request", () => {
    // Given a site's transaction request naming Paseo's Asset Hub on another network
    const request = requestOf('sign', { v: 1, net: 'previewnet', chain: PASEO_HUB });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then the site's request does not parse
    expect(round).toEqual({ kind: 'refuse', reason: 'bad_request' });
  });

  it("As a sign-in window opened by a site, I get dot.li's own request and refuse it as a bad request", () => {
    // Given a first-party request with an intent and no nonce
    const request = requestOf('auth', { v: 1, net: 'paseo-next-v2', intent: 'resume' });

    // When the window dispatches its round for a site
    const round = dispatchRound(request, 'third', ENABLED);

    // Then a site may not ask for a first-party intent
    expect(round).toEqual({ kind: 'refuse', reason: 'bad_request' });
  });
});
