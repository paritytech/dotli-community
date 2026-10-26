// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import type { SessionRequest } from '../session-handoff/session-protocol.js';
import { parseSiteCall, parseSiteSignRequest } from './site-sign-request.js';

const PASEO_HUB = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].assethub.genesis;
const PREVIEW_HUB = NETWORK_NAME_TO_SERVICES_CONFIG.previewnet.assethub.genesis;

/** A transaction request on Paseo, naming its Asset Hub, with `extra` over its fields. */
const request = (extra: Record<string, unknown>): SessionRequest => ({
  route: 'sign',
  round: 'r1',
  v: 1,
  net: 'paseo-next-v2',
  params: { v: 1, net: 'paseo-next-v2', round: 'r1', chain: PASEO_HUB, ...extra },
});

const token = (bytes: number) => base64urlnopad.encode(new Uint8Array(bytes).fill(7));

/** `0x` hex of `bytes` bytes. */
const callOf = (bytes: number) => `0x${'ab'.repeat(bytes)}`;

describe('site sign request', () => {
  it('As a site, I send a call and a token and the window reads the round, the token and the call', () => {
    // Given a request with its call in the URL and a site token
    const input = request({ call: '0x0a03', site_token: token(32) });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then all three are read
    expect(parsed).toEqual({ round: 'r1', siteToken: token(32), chain: PASEO_HUB, call: '0x0a03', groupToken: null });
  });

  it('As a site, I send no call and no token and the window reads both as absent', () => {
    // Given a request whose call follows as a payload
    const input = request({});

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then the call and the token are null
    expect(parsed).toEqual({ round: 'r1', siteToken: null, chain: PASEO_HUB, call: null, groupToken: null });
  });

  it("As a site, I name another network's Asset Hub and the request is refused", () => {
    // Given a Paseo request naming Previewnet's Asset Hub
    const input = request({ chain: PREVIEW_HUB });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it("As a site, I name the network's Asset Hub in uppercase hex and the request is read", () => {
    // Given the Asset Hub's genesis with uppercase hex digits
    const input = request({ chain: `0x${PASEO_HUB.slice(2).toUpperCase()}` });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is read
    expect(parsed).toEqual({ round: 'r1', siteToken: null, chain: PASEO_HUB, call: null, groupToken: null });
  });

  it.each<[string, unknown]>([
    ['no chain', undefined],
    ['a non-string chain', 7],
    ['the relay chain', NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].relay.genesis],
  ])('As a site, I send %s and the request is refused', (_name, chain) => {
    // Given a request with that chain
    const input = request({ chain });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a 1-byte call', '0x0a'],
    ['a call of odd hex', '0x0a0'],
    ['a call with no 0x', '0a03'],
    ['a call of non-hex', '0x0g03'],
    ['an empty call', ''],
    ['a non-string call', 7],
  ])('As a site, I send %s and the request is refused', (_name, call) => {
    // Given a request with that call
    const input = request({ call });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it.each<[string, unknown]>([
    ['31 bytes', token(31)],
    ['a non-base64url string', '!'.repeat(43)],
    ['a non-string', 7],
  ])('As a site, I send a site token of %s and the request is refused', (_name, siteToken) => {
    // Given a request with that token
    const input = request({ site_token: siteToken });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it('As a site, I send an intent and the request is refused', () => {
    // Given a request that carries a key this stage refuses
    const input = request({ intent: 'signin' });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it('As a site, I send a group token with my transaction and the window reads it', () => {
    // Given a request under a group
    const input = request({ group_token: 'my group', site_token: token(32) });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then the group token is read beside the site token
    expect(parsed).toEqual({ round: 'r1', siteToken: token(32), chain: PASEO_HUB, call: null, groupToken: 'my group' });
  });

  it.each<[string, unknown]>([
    ['an empty group token', ''],
    ['a group token of 257 characters', 'a'.repeat(257)],
    ['a group token with a line break', 'a\nb'],
    ['a group token with a lone surrogate', 'a\uD800'],
    ['a non-string group token', 7],
  ])('As a site, I send %s with my transaction and the request is refused', (_name, groupToken) => {
    // Given a request with that group token
    const input = request({ group_token: groupToken });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it('As a site, I send fields the window does not know and it reads the request as without them', () => {
    // Given a request with a nonce and a return address
    const input = request({ nonce: 'abcdefgh', return_to: 'https://x.example' });

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then they change nothing
    expect(parsed).toEqual({ round: 'r1', siteToken: null, chain: PASEO_HUB, call: null, groupToken: null });
  });
});

describe('site call', () => {
  it.each([
    ['1 byte', callOf(1), null],
    ['2 bytes', callOf(2), 2],
    ['1 000 000 bytes', callOf(1_000_000), 1_000_000],
    ['1 000 001 bytes', callOf(1_000_001), null],
  ])('As a session window, I read a call of %s and get its bytes only within bounds', (_name, call, length) => {
    // Given the call

    // When the window reads it
    const bytes = parseSiteCall(call);

    // Then it has its bytes only when it is 2 to 1 000 000 bytes long
    expect(bytes?.length ?? null).toBe(length);
  });

  it('As a session window, I read a call in mixed-case hex and get its bytes', () => {
    // Given a call with uppercase digits
    const call = '0x0A0b';

    // When the window reads it
    const bytes = parseSiteCall(call);

    // Then it has the bytes it spells
    expect(bytes).toEqual(Uint8Array.of(0x0a, 0x0b));
  });

  it.each(['0x0a0', '0X0a03', '0x0a 3', '0x'])('As a session window, I read the call %j and find no bytes', call => {
    // Given a call that is not 0x hex of whole bytes

    // When the window reads it
    const bytes = parseSiteCall(call);

    // Then it has none
    expect(bytes).toBeNull();
  });
});
