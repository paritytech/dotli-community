// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { base64urlnopad, utf8 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { readRequestParams, readSessionRequest } from './readSessionRequest.js';

/** A fragment that carries `json` as its `params` value. */
function createParamsHash(json: string) {
  return `#params=${base64urlnopad.encode(utf8.decode(json))}`;
}

describe('session requests', () => {
  it.each([{ hash: '' }, { hash: '#other=1' }])(
    'As a user, I open a session window with the fragment $hash and it finds no request params',
    row => {
      // Given the window's fragment
      const { hash } = row;

      // When the window reads it
      const params = readRequestParams(hash);

      // Then there are no params
      expect(params).toBeUndefined();
    },
  );

  it.each([
    { name: 'broken base64url', hash: '#params=***' },
    { name: 'broken JSON', hash: createParamsHash('{nope') },
    { name: 'a JSON array', hash: createParamsHash('[1]') },
    { name: 'a JSON null', hash: createParamsHash('null') },
  ])('As a user, I open a session window whose params are $name and it takes them as broken', row => {
    // Given the window's fragment
    const { hash } = row;

    // When the window reads it
    const params = readRequestParams(hash);

    // Then the params are null
    expect(params).toBeNull();
  });

  it('As a site, I send a request of another version, an unknown network and extra fields and the window keeps them all', () => {
    // Given params with version 2, a network this build does not know and a field of another party
    const params = { v: 2, net: 'nope', round: 'r1', nonce: 'abcdefgh' };

    // When the window reads them on the auth route
    const request = readSessionRequest('auth', params);

    // Then it keeps the version, the network and every field for whoever judges them
    expect(request).toEqual({ route: 'auth', round: 'r1', version: 2, network: 'nope', params });
  });

  it('As a site, I send a request whose version and network are not of their type and the window keeps them as unknown', () => {
    // Given params whose version is a string and whose network is a number
    const params = { v: '1', net: 7, round: 'r1' };

    // When the window reads them
    const request = readSessionRequest('signout', params);

    // Then the version and the network are null
    expect(request).toEqual({ route: 'signout', round: 'r1', version: null, network: null, params });
  });

  it.each<{ name: string; params: Record<string, unknown> }>([
    { name: 'no round', params: { v: 1, net: 'paseo-next-v2' } },
    { name: 'an empty round', params: { v: 1, net: 'paseo-next-v2', round: '' } },
    { name: 'a non-string round', params: { v: 1, net: 'paseo-next-v2', round: 7 } },
  ])('As a site, I send a request with $name and the window finds none, since there is no round to answer', row => {
    // Given the request's params
    const { params } = row;

    // When the window reads them
    const request = readSessionRequest('auth', params);

    // Then there is no request
    expect(request).toBeNull();
  });
});
