// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { asProductId, type ProductAccountId } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import type { SessionRequest } from '../sessionHandoff/readSessionRequest.js';
import { parseSiteCall, parseSiteSignRequest, type SiteSignRequest } from './parseSiteSignRequest.js';
import { createSiteToken } from '../../testing/createSiteToken.js';

const PASEO_HUB = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].assethub.genesis;
const PRODUCT = `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.TLD}`;
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: asProductId(PRODUCT),
  derivationIndex: { tag: 'Index', value: 0 },
};
const PREVIEW_HUB = NETWORK_NAME_TO_SERVICES_CONFIG.previewnet.assethub.genesis;
/** What a request with no call, token or group token reads as. */
const READ: SiteSignRequest = {
  round: 'r1',
  account: ACCOUNT,
  siteToken: null,
  chain: PASEO_HUB,
  call: null,
  groupToken: null,
};

/** A transaction request on Paseo, naming its Asset Hub, with `extra` over its fields. */
function createRequest(extra: Record<string, unknown>): SessionRequest {
  return {
    route: 'sign',
    round: 'r1',
    version: 1,
    network: 'paseo-next-v2',
    params: { v: 1, net: 'paseo-next-v2', round: 'r1', chain: PASEO_HUB, account: `${PRODUCT}/0`, ...extra },
  };
}

/** `0x` hex of `bytes` bytes. */
function createCall(bytes: number): string {
  return `0x${'ab'.repeat(bytes)}`;
}

describe('site sign request', () => {
  it.each<{ name: string; extra: Record<string, unknown>; read: Partial<SiteSignRequest> }>([
    {
      name: 'a call and a token',
      extra: { call: '0x0a03', site_token: createSiteToken(32) },
      read: { siteToken: createSiteToken(32), call: '0x0a03' },
    },
    { name: 'no call and no token, as the call follows as a payload,', extra: {}, read: {} },
    {
      name: "the network's Asset Hub in uppercase hex",
      extra: { chain: `0x${PASEO_HUB.slice(2).toUpperCase()}` },
      read: {},
    },
    {
      name: 'a group token beside my site token',
      extra: { group_token: 'my group', site_token: createSiteToken(32) },
      read: { siteToken: createSiteToken(32), groupToken: 'my group' },
    },
    {
      name: 'a nonce and a return address the window does not know',
      extra: { nonce: 'abcdefgh', return_to: 'https://x.example' },
      read: {},
    },
  ])('As a site, I send $name and the window reads my request', ({ extra, read }) => {
    // Given a request with those fields
    const input = createRequest(extra);

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then the round, the account, the chain and what the request carries are read, and nothing else
    expect(parsed).toEqual({ ...READ, ...read });
  });

  it.each<{ name: string; extra: Record<string, unknown> }>([
    { name: 'no account', extra: { account: undefined } },
    { name: 'an account that names no network TLD', extra: { account: 'myapp/0' } },
    { name: "another network's Asset Hub", extra: { chain: PREVIEW_HUB } },
    { name: 'no chain', extra: { chain: undefined } },
    { name: 'a non-string chain', extra: { chain: 7 } },
    { name: 'the relay chain', extra: { chain: NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].relay.genesis } },
    { name: 'a 1-byte call', extra: { call: '0x0a' } },
    { name: 'a call of odd hex', extra: { call: '0x0a0' } },
    { name: 'a call with no 0x', extra: { call: '0a03' } },
    { name: 'a call of non-hex', extra: { call: '0x0g03' } },
    { name: 'an empty call', extra: { call: '' } },
    { name: 'a non-string call', extra: { call: 7 } },
    { name: 'a site token of 31 bytes', extra: { site_token: createSiteToken(31) } },
    { name: 'a site token of a non-base64url string', extra: { site_token: '!'.repeat(43) } },
    { name: 'a site token of a non-string', extra: { site_token: 7 } },
    { name: 'an intent', extra: { intent: 'signin' } },
    { name: 'an empty group token', extra: { group_token: '' } },
    { name: 'a group token of 257 characters', extra: { group_token: 'a'.repeat(257) } },
    { name: 'a group token with a line break', extra: { group_token: 'a\nb' } },
    { name: 'a group token with a lone surrogate', extra: { group_token: 'a\uD800' } },
    { name: 'a non-string group token', extra: { group_token: 7 } },
  ])('As a site, I send $name with my transaction and the window refuses my request', ({ extra }) => {
    // Given a request with that field
    const input = createRequest(extra);

    // When it is parsed
    const parsed = parseSiteSignRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });
});

describe('site call', () => {
  it.each([
    { name: '1 byte', bytes: 1, length: null },
    { name: '2 bytes', bytes: 2, length: 2 },
    { name: '1 000 000 bytes', bytes: 1_000_000, length: 1_000_000 },
    { name: '1 000 001 bytes', bytes: 1_000_001, length: null },
  ])('As a site, I send a call of $name and the window reads its bytes only within bounds', ({ bytes, length }) => {
    // Given a call of that many bytes
    const call = createCall(bytes);

    // When the window reads it
    const read = parseSiteCall(call);

    // Then it has its bytes only when it is 2 to 1 000 000 bytes long
    expect(read?.length ?? null).toBe(length);
  });

  it('As a site, I send a call in mixed-case hex and the window reads its bytes', () => {
    // Given a call with uppercase digits
    const call = '0x0A0b';

    // When the window reads it
    const bytes = parseSiteCall(call);

    // Then it has the bytes it spells
    expect(bytes).toEqual(Uint8Array.of(0x0a, 0x0b));
  });

  it.each([{ call: '0x0a0' }, { call: '0X0a03' }, { call: '0x0a 3' }, { call: '0x' }])(
    'As a site, I send the call $call and the window finds no bytes',
    row => {
      // Given a call that is not 0x hex of whole bytes
      const { call } = row;

      // When the window reads it
      const bytes = parseSiteCall(call);

      // Then it has none
      expect(bytes).toBeNull();
    },
  );
});
