// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { base64urlnopad, utf8 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  READY,
  parseHello,
  parsePageMessage,
  readRequestParams,
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
    ['/s/auth/', null],
    ['/s/sign', null],
    ['/', null],
  ])('As a window, I map the path %s and find its route', (path, route) => {
    // Given the path

    // When the window maps it
    const found = routeOfPath(path);

    // Then it finds the route, or none
    expect(found).toBe(route);
  });
});
