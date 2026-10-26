// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import type { SessionRequest } from '../session-handoff/session-protocol.js';
import { parseSiteRequest, readRedirectFields } from './site-request.js';

const NONCE = 'abcd1234';
const PRODUCT = `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.TLD}`;

const request = (extra: Record<string, unknown>): SessionRequest => ({
  route: 'auth',
  round: 'r1',
  v: 1,
  net: 'paseo-next-v2',
  params: { v: 1, net: 'paseo-next-v2', round: 'r1', nonce: NONCE, account: `${PRODUCT}/0`, ...extra },
});

const token = (bytes: number) => base64urlnopad.encode(new Uint8Array(bytes).fill(7));

describe('site request', () => {
  it('As a site, I send a nonce and the window reads the round, nonce and no statement or token', () => {
    // Given a request with a nonce only
    const input = request({});

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then the fields are read and the optional ones are null
    expect(parsed).toEqual({
      round: 'r1',
      nonce: NONCE,
      account: { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Index', value: 0 } },
      statement: null,
      siteToken: null,
      groupToken: null,
    });
  });

  it.each([
    ['7 characters', 'abcd123', false],
    ['8 characters', 'abcd1234', true],
    ['128 characters', 'a'.repeat(128), true],
    ['129 characters', 'a'.repeat(129), false],
    ['a non-alphanumeric character', 'abcd-1234', false],
    ['an empty string', '', false],
  ])('As a site, I send a nonce of %s and it is accepted: %s', (_name, nonce, accepted) => {
    // Given a request with that nonce
    const input = request({ nonce });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then it is read only when the nonce is in bounds
    expect(parsed !== null).toBe(accepted);
  });

  it('As a site, I send no nonce or a non-string one and the request is refused', () => {
    // Given requests without a usable nonce
    const missing = request({ nonce: undefined });
    const numeric = request({ nonce: 12345678 });

    // When they are parsed
    const results = [parseSiteRequest(missing, 'paseo-next-v2'), parseSiteRequest(numeric, 'paseo-next-v2')];

    // Then both are refused
    expect(results).toEqual([null, null]);
  });

  it('As a site, I leave out the account and the window refuses my request', () => {
    // Given a request without an account
    const input = request({ account: undefined });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it('As a site, I send a malformed account and the window refuses my request', () => {
    // Given a request whose account names no network TLD
    const input = request({ account: 'myapp/0' });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it.each([
    ['an empty statement', '', false],
    ['a one character statement', 'a', true],
    ['a 512 character statement', 'a'.repeat(512), true],
    ['a 513 character statement', 'a'.repeat(513), false],
    ['a line feed', 'a\nb', false],
    ['a carriage return', 'a\rb', false],
    ['a line separator', 'a\u2028b', false],
    ['a paragraph separator', 'a\u2029b', false],
    ['a leading URI marker', 'URI: https://evil.example', false],
    ['an inner URI marker', 'see URI: here', true],
    ['a non-string', 5, false],
  ])('As a site, I send %s and it is accepted: %s', (_name, statement, accepted) => {
    // Given a request with that statement
    const input = request({ statement });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then the statement is kept only when it is valid
    expect(parsed?.statement ?? null).toBe(accepted ? statement : null);
    expect(parsed !== null).toBe(accepted);
  });

  it.each([
    ['31 bytes', token(31), false],
    ['32 bytes', token(32), true],
    ['33 bytes', token(33), false],
    ['32 bytes with padding', `${token(32)}=`, false],
    ['a non-base64url string', '!'.repeat(43), false],
    ['a non-string', 7, false],
  ])('As a site, I send a site token of %s and it is accepted: %s', (_name, siteToken, accepted) => {
    // Given a request with that token
    const input = request({ site_token: siteToken });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then the token is kept only when it is 32 bytes unpadded
    expect(parsed?.siteToken ?? null).toBe(accepted ? siteToken : null);
    expect(parsed !== null).toBe(accepted);
  });

  it('As a site, I send an intent and the request is refused', () => {
    // Given a request that carries a key this stage refuses
    const input = request({ intent: 'signin' });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then it is refused
    expect(parsed).toBeNull();
  });

  it.each<[string, unknown, boolean]>([
    ['one character', 'a', true],
    ['256 characters', 'a'.repeat(256), true],
    ['spaces and symbols', 'a b/c%d', true],
    ['a surrogate pair', 'team 😀', true],
    ['an empty string', '', false],
    ['257 characters', 'a'.repeat(257), false],
    ['a line feed', 'a\nb', false],
    ['a carriage return', 'a\rb', false],
    ['a line separator', 'a b', false],
    ['a paragraph separator', 'a b', false],
    ['a lone high surrogate', 'a\uD800b', false],
    ['a lone low surrogate', 'a\uDC00', false],
    ['a non-string', 7, false],
  ])('As a site, I send a group token of %s and it is accepted: %s', (_name, groupToken, accepted) => {
    // Given a request with that group token
    const input = request({ group_token: groupToken });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then the group token is kept only when it is valid, and an invalid one is a bad request
    expect(parsed?.groupToken ?? null).toBe(accepted ? groupToken : null);
    expect(parsed !== null).toBe(accepted);
  });

  it('As a site, I send return_to and pub and the window ignores them', () => {
    // Given a request with unknown fields
    const input = request({ return_to: 'https://x.example', pub: '0x00' });

    // When it is parsed
    const parsed = parseSiteRequest(input, 'paseo-next-v2');

    // Then it is read as if they were absent
    expect(parsed).toEqual({
      round: 'r1',
      nonce: NONCE,
      account: { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Index', value: 0 } },
      statement: null,
      siteToken: null,
      groupToken: null,
    });
  });
});

const KEY = new Uint8Array(32).fill(5);
const PUB = base64urlnopad.encode(KEY);
const RETURN_TO = 'https://site.example/back?x=1';

describe('redirect fields', () => {
  it('As a site, I send return_to and pub and the window reads the return address and the key', () => {
    // Given params with both redirect fields
    const params = { round: 'r1', return_to: RETURN_TO, pub: PUB };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then both come back, the key as its bytes
    expect(fields).toEqual({ returnTo: RETURN_TO, pub: KEY });
  });

  it('As a site, I send neither field and the window reads no redirect', () => {
    // Given params with no redirect field
    const params = { round: 'r1', nonce: NONCE };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then there is no redirect
    expect(fields).toBe('none');
  });

  it.each<[string, Record<string, unknown>]>([
    ['return_to alone', { return_to: RETURN_TO }],
    ['pub alone', { pub: PUB }],
    ['an http return_to off localhost', { return_to: 'http://site.example/back', pub: PUB }],
    ['a return_to with a fragment', { return_to: 'https://site.example/back#x', pub: PUB }],
    ['a return_to with an empty fragment', { return_to: 'https://site.example/back#', pub: PUB }],
    ['a relative return_to', { return_to: '/back', pub: PUB }],
    ['a return_to of another scheme', { return_to: 'javascript:alert(1)', pub: PUB }],
    ['a non-string return_to', { return_to: 7, pub: PUB }],
    ['a 31-byte pub', { return_to: RETURN_TO, pub: base64urlnopad.encode(new Uint8Array(31)) }],
    ['a 33-byte pub', { return_to: RETURN_TO, pub: base64urlnopad.encode(new Uint8Array(33)) }],
    ['a padded pub', { return_to: RETURN_TO, pub: `${PUB}=` }],
    ['a non-string pub', { return_to: RETURN_TO, pub: 5 }],
  ])('As a site, I send %s and the window reads the redirect as invalid', (_name, extra) => {
    // Given params with that redirect field or fields
    const params = { round: 'r1', ...extra };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then they are invalid
    expect(fields).toBe('invalid');
  });

  it('As a local site, I send an http return_to on localhost and the window reads it', () => {
    // Given a return address on a localhost page over http
    const params = { round: 'r1', return_to: 'http://localhost:3000/back', pub: PUB };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then the return address is accepted
    expect(fields).toEqual({ returnTo: 'http://localhost:3000/back', pub: KEY });
  });
});
