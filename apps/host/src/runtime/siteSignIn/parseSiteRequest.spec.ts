// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { SessionRequest } from '../sessionHandoff/readSessionRequest.js';
import { parseSiteRequest } from './parseSiteRequest.js';
import { createSiteToken } from '../../testing/createSiteToken.js';

/** A sign-in request on Paseo for round r1, with `extra` over its fields. */
function createRequest(extra: Record<string, unknown>): SessionRequest {
  return {
    route: 'auth',
    round: 'r1',
    version: 1,
    network: 'paseo-next-v2',
    params: { v: 1, net: 'paseo-next-v2', round: 'r1', ...extra },
  };
}

describe('site request', () => {
  it.each<{ name: string; extra: Record<string, unknown> }>([
    { name: 'only a round', extra: {} },
    {
      name: 'an account, a nonce and a statement, as older sites still do,',
      extra: { account: 'myapp.paseo/0', nonce: 'abc', statement: 'x\ny' },
    },
    { name: 'return_to and pub', extra: { return_to: 'https://x.example', pub: '0x00' } },
  ])('As a site, I sign in with $name and the window reads a request with only its round', ({ extra }) => {
    // Given a request with those fields
    const input = createRequest(extra);

    // When it is parsed
    const parsed = parseSiteRequest(input);

    // Then the round is read, anything else is ignored and the tokens are null
    expect(parsed).toEqual({ round: 'r1', siteToken: null, groupToken: null });
  });

  it.each<{ name: string; siteToken: unknown; accepted: boolean }>([
    { name: '31 bytes', siteToken: createSiteToken(31), accepted: false },
    { name: '32 bytes', siteToken: createSiteToken(32), accepted: true },
    { name: '33 bytes', siteToken: createSiteToken(33), accepted: false },
    { name: '32 bytes with padding', siteToken: `${createSiteToken(32)}=`, accepted: false },
    { name: 'a non-base64url string', siteToken: '!'.repeat(43), accepted: false },
    { name: 'a non-string', siteToken: 7, accepted: false },
  ])('As a site, I send a site token of $name and it is accepted: $accepted', ({ siteToken, accepted }) => {
    // Given a request with that token
    const input = createRequest({ site_token: siteToken });

    // When it is parsed
    const parsed = parseSiteRequest(input);

    // Then the token is kept only when it is 32 bytes unpadded
    expect(parsed?.siteToken ?? null).toBe(accepted ? siteToken : null);
    expect(parsed !== null).toBe(accepted);
  });

  it('As a site, I send an intent and the request is refused', () => {
    // Given a request that carries a key this stage refuses
    const input = createRequest({ intent: 'signin' });

    // When it is parsed
    const parsed = parseSiteRequest(input);

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it.each<{ name: string; groupToken: unknown; accepted: boolean }>([
    { name: 'one character', groupToken: 'a', accepted: true },
    { name: '256 characters', groupToken: 'a'.repeat(256), accepted: true },
    { name: 'spaces and symbols', groupToken: 'a b/c%d', accepted: true },
    { name: 'a surrogate pair', groupToken: 'team 😀', accepted: true },
    { name: 'an empty string', groupToken: '', accepted: false },
    { name: '257 characters', groupToken: 'a'.repeat(257), accepted: false },
    { name: 'a line feed', groupToken: 'a\nb', accepted: false },
    { name: 'a carriage return', groupToken: 'a\rb', accepted: false },
    { name: 'a line separator', groupToken: 'a b', accepted: false },
    { name: 'a paragraph separator', groupToken: 'a b', accepted: false },
    { name: 'a lone high surrogate', groupToken: 'a\uD800b', accepted: false },
    { name: 'a lone low surrogate', groupToken: 'a\uDC00', accepted: false },
    { name: 'a non-string', groupToken: 7, accepted: false },
  ])('As a site, I send a group token of $name and it is accepted: $accepted', ({ groupToken, accepted }) => {
    // Given a request with that group token
    const input = createRequest({ group_token: groupToken });

    // When it is parsed
    const parsed = parseSiteRequest(input);

    // Then the group token is kept only when it is valid, and an invalid one is a bad request
    expect(parsed?.groupToken ?? null).toBe(accepted ? groupToken : null);
    expect(parsed !== null).toBe(accepted);
  });
});
