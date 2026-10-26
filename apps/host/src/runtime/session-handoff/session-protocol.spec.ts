// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { base64urlnopad, utf8 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  READY,
  parseHello,
  parsePageMessage,
  parsePayload,
  readRequestParams,
  readSessionRequest,
  requestUrl,
  routeOfPath,
} from './session-protocol.js';

/** A fragment that carries `json` as its `params` value. */
const paramsHash = (json: string) => `#params=${base64urlnopad.encode(utf8.decode(json))}`;

describe('session protocol', () => {
  it('As a page, I build a request URL and read its params back unchanged', () => {
    // Given params whose JSON length is not a multiple of 3, so base64 would pad them
    const params = { v: 1, net: 'paseo-next-v2', round: 'r12', intent: 'signin' };

    // When the URL is built and its fragment is read
    const url = requestUrl('https://dot.li', 'auth', params);
    const read = readRequestParams(new URL(url).hash);

    // Then the URL is on the auth route, carries no padding and reads back as the params
    expect(url.startsWith('https://dot.li/s/auth#params=')).toBe(true);
    expect(url.split('#params=')[1]).not.toContain('=');
    expect(read).toEqual(params);
  });

  it('As a site, I build a transaction request and it lands on the sign route', () => {
    // Given a site's transaction params
    const params = { v: 1, net: 'paseo-next-v2', round: 'r3', chain: '0x01', call: '0x0001' };

    // When the URL is built
    const url = requestUrl('https://dot.li', 'sign', params);

    // Then the URL is on the sign route
    expect(url.startsWith('https://dot.li/s/sign#params=')).toBe(true);
  });

  it('As a page, I build a sign-out request and it lands on its own route', () => {
    // Given sign-out params
    const params = { v: 1, net: 'paseo-next-v2', round: 'r2', notified: true };

    // When the URL is built
    const url = requestUrl('https://dot.li', 'signout', params);

    // Then the URL is on the signout route
    expect(url.startsWith('https://dot.li/s/signout#params=')).toBe(true);
  });

  it.each(['', '#other=1'])('As a window, I read the fragment %j and find no params', hash => {
    // Given the fragment

    // When the window reads it
    const params = readRequestParams(hash);

    // Then there are no params
    expect(params).toBeUndefined();
  });

  it.each([
    ['broken base64url', '#params=***'],
    ['broken JSON', paramsHash('{nope')],
    ['a JSON array', paramsHash('[1]')],
    ['a JSON null', paramsHash('null')],
  ])('As a window, I read broken params (%s) and take them as broken', (_name, hash) => {
    // Given the fragment

    // When the window reads it
    const params = readRequestParams(hash);

    // Then the params are null
    expect(params).toBeNull();
  });

  it('As a window, I parse a hello only in its exact shape and reject the rest', () => {
    // Given a valid hello and payloads that break its shape
    const valid = { type: 'dotli:s:hello', v: 1, round: 'r1' };
    const broken = [
      { type: 'dotli:s:hello', round: 'r1' },
      { type: 'dotli:s:hello', v: 1, round: 7 },
      { type: 'dotli:s:ready', v: 1, round: 'r1' },
      null,
    ];

    // When each is parsed
    const parsed = parseHello(valid);
    const rejected = broken.map(parseHello);

    // Then only the valid one parses
    expect(parsed).toEqual(valid);
    expect(rejected).toEqual([null, null, null, null]);
  });

  it("As a window, I parse a site's payload only in its exact shape and reject the rest", () => {
    // Given a valid payload and messages that break its shape
    const valid = { type: 'dotli:s:payload', round: 'r1', call: '0x0001' };
    const broken = [
      { type: 'dotli:s:payload', round: 'r1', call: 7 },
      { type: 'dotli:s:payload', round: 'r1' },
      { type: 'dotli:s:payload', round: 1, call: '0x0001' },
      { type: 'dotli:s:hello', round: 'r1', call: '0x0001' },
      null,
    ];

    // When each is parsed
    const parsed = parsePayload({ ...valid, extra: true });
    const rejected = broken.map(parsePayload);

    // Then only the valid one parses, to its three fields
    expect(parsed).toEqual(valid);
    expect(rejected).toEqual(broken.map(() => null));
  });

  it('As an opener, I parse ready, result and refused and reject everything else', () => {
    // Given the three messages and payloads that are none of them
    const ready = { type: 'dotli:s:ready', versions: [1] };
    const result = { type: 'dotli:s:result', round: 'r1', result: null };
    const refused = { type: 'dotli:s:refused', round: 'r1', reason: 'origin_not_allowed' };
    const others = [
      { type: 'dotli:s:hello', v: 1, round: 'r1' },
      { type: 'dotli:s:ready', versions: ['1'] },
      { type: 'dotli:s:ready' },
      { type: 'dotli:s:result', round: 'r1' },
      { type: 'dotli:s:result', round: 1, result: 1 },
      { type: 'dotli:s:refused', round: 'r1' },
      'dotli:s:ready',
    ];

    // When each is parsed
    const parsed = [ready, result, refused].map(parsePageMessage);
    const rejected = others.map(parsePageMessage);

    // Then the three parse and the rest do not
    expect(parsed).toEqual([ready, result, refused]);
    expect(rejected).toEqual(others.map(() => null));
  });

  it('As an opener, I parse a cancel and a result that carries a site token', () => {
    // Given a cancel and a result with a site token
    const cancelled = { type: 'dotli:s:cancelled', round: 'r1' };
    const result = { type: 'dotli:s:result', round: 'r1', result: null, site_token: 'tok' };

    // When each is parsed
    const parsed = [cancelled, result].map(parsePageMessage);

    // Then both read back unchanged
    expect(parsed).toEqual([cancelled, result]);
  });

  it.each([
    ['a cancel without its round', { type: 'dotli:s:cancelled' }],
    ['a cancel with a non-string round', { type: 'dotli:s:cancelled', round: 1 }],
    ['a result with a non-string site token', { type: 'dotli:s:result', round: 'r1', result: null, site_token: 7 }],
  ])('As an opener, I reject %s', (_name, data) => {
    // Given the broken message

    // When it is parsed
    const parsed = parsePageMessage(data);

    // Then it is rejected
    expect(parsed).toBeNull();
  });

  it('As a window, I read a request of another version, an unknown network and extra fields and keep them all', () => {
    // Given params with version 2, a network this build does not know and a field of another party
    const params = { v: 2, net: 'nope', round: 'r1', nonce: 'abcdefgh' };

    // When the window reads them on the auth route
    const request = readSessionRequest('auth', params);

    // Then it keeps the version, the network and every field for whoever judges them
    expect(request).toEqual({ route: 'auth', round: 'r1', v: 2, net: 'nope', params });
  });

  it('As a window, I read a request whose version and network are not of their type and keep them as unknown', () => {
    // Given params whose version is a string and whose network is a number
    const params = { v: '1', net: 7, round: 'r1' };

    // When the window reads them
    const request = readSessionRequest('signout', params);

    // Then the version and the network are null
    expect(request).toEqual({ route: 'signout', round: 'r1', v: null, net: null, params });
  });

  it.each<[string, Record<string, unknown>]>([
    ['no round', { v: 1, net: 'paseo-next-v2' }],
    ['an empty round', { v: 1, net: 'paseo-next-v2', round: '' }],
    ['a non-string round', { v: 1, net: 'paseo-next-v2', round: 7 }],
  ])('As a window, I read a request with %s and find none, since there is no round to answer', (_name, params) => {
    // Given the params

    // When the window reads them
    const request = readSessionRequest('auth', params);

    // Then there is no request
    expect(request).toBeNull();
  });

  it('As a window, I announce my version in my ready and an opener reads it', () => {
    // Given the exported ready

    // When an opener parses it
    const parsed = parsePageMessage(READY);

    // Then it names the version
    expect(parsed).toEqual({ type: 'dotli:s:ready', versions: [PROTOCOL_VERSION] });
  });

  it.each([
    ['/s/auth', 'auth'],
    ['/s/signout', 'signout'],
    ['/s/manage', 'manage'],
    ['/s/auth/', null],
    ['/s/sign', 'sign'],
    ['/s/sign/', null],
    ['/', null],
  ])('As a window, I map the path %s and find its route', (path, route) => {
    // Given the path

    // When the window maps it
    const found = routeOfPath(path);

    // Then it finds the route, or none
    expect(found).toBe(route);
  });
});
