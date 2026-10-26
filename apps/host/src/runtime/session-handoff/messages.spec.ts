// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { must } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  parseSessionResult,
  parseWindowRequest,
  signInWindowUrl,
  signOutWindowUrl,
  SIGNED_OUT_RESULT,
} from './messages.js';
import { readRequestParams } from './session-protocol.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

/** The params a window reads from a request URL's fragment. */
const paramsOf = (url: string) => must(readRequestParams(new URL(url).hash), 'request params');

describe('window requests', () => {
  it('As a page, I build a sign-in window URL and the window reads it back as my request', () => {
    // Given a sign-in request URL
    const url = signInWindowUrl('phrase', 'paseo-next-v2', 'r1', 'https://dot.li');

    // When the window reads it
    const request = parseWindowRequest('auth', paramsOf(url));

    // Then it is my request
    expect(request).toEqual({ route: 'auth', net: 'paseo-next-v2', round: 'r1', intent: 'phrase' });
    expect(url.startsWith('https://dot.li/s/auth#params=')).toBe(true);
  });

  it('As a page, I build a sign-out URL and it carries notified only when I told the phone', () => {
    // Given sign-out URLs for both cases
    const toldUrl = signOutWindowUrl(true, 'paseo-next-v2', 'r2', 'https://dot.li');
    const untoldUrl = signOutWindowUrl(false, 'paseo-next-v2', 'r2', 'https://dot.li');

    // When the window reads them
    const told = parseWindowRequest('signout', paramsOf(toldUrl));
    const untold = paramsOf(untoldUrl);

    // Then notified travels only when true
    expect(told).toEqual({ route: 'signout', net: 'paseo-next-v2', round: 'r2', notified: true });
    expect('notified' in untold).toBe(false);
    expect(parseWindowRequest('signout', untold)).toEqual({
      route: 'signout',
      net: 'paseo-next-v2',
      round: 'r2',
      notified: false,
    });
  });

  it('As a window, I read a notified other than true and take it as false', () => {
    // Given a sign-out request whose notified is a string
    const params = { v: 1, net: 'paseo-next-v2', round: 'r', notified: 'true' };

    // When it is parsed
    const request = parseWindowRequest('signout', params);

    // Then it reads as false
    expect(request).toEqual({ route: 'signout', net: 'paseo-next-v2', round: 'r', notified: false });
  });

  it.each<[string, Record<string, unknown>]>([
    ['another v', { v: 2, net: 'paseo-next-v2', round: 'r', intent: 'signin' }],
    ['no v', { net: 'paseo-next-v2', round: 'r', intent: 'signin' }],
    ['an unknown network', { v: 1, net: 'nope', round: 'r', intent: 'signin' }],
    ['a missing round', { v: 1, net: 'paseo-next-v2', intent: 'signin' }],
    ['an empty round', { v: 1, net: 'paseo-next-v2', round: '', intent: 'signin' }],
    ['an unknown intent', { v: 1, net: 'paseo-next-v2', round: 'r', intent: 'signout' }],
    ['a missing intent', { v: 1, net: 'paseo-next-v2', round: 'r' }],
  ])('As a window, I refuse a request with %s and it reads as null', (_name, params) => {
    // Given a request that breaks the contract

    // When the auth window parses it
    const request = parseWindowRequest('auth', params);

    // Then it is null
    expect(request).toBeNull();
  });

  it('As a window, I refuse a sign-out request with another v and it reads as null', () => {
    // Given a sign-out request of another version
    const params = { v: 2, net: 'paseo-next-v2', round: 'r' };

    // When it is parsed
    const request = parseWindowRequest('signout', params);

    // Then it is null
    expect(request).toBeNull();
  });

  it('As a window, I ignore request fields I do not know and read the request as without them', () => {
    // Given a request and the same with an extra field
    const base = { v: 1, net: 'paseo-next-v2', round: 'r', intent: 'signin' };

    // When both are parsed
    const withExtra = parseWindowRequest('auth', { ...base, site_token: 'x' });

    // Then the extra field changes nothing
    expect(withExtra).toEqual(parseWindowRequest('auth', base));
    expect(withExtra).not.toBeNull();
  });
});

describe('session results', () => {
  it('As a page, I read a result with no session and no wallet and get it unchanged', () => {
    // Given a well formed empty result
    const value = { session: null, localWallet: null };

    // When it is parsed
    const result = parseSessionResult(value);

    // Then it comes back unchanged
    expect(result).toEqual(value);
  });

  it('As a page, I read a result with a session and a wallet and get it unchanged', () => {
    // Given a full result
    const result = { session: { blob: 'b', uiState: null }, localWallet: { entropy: ENTROPY, identity: null } };

    // When it is parsed
    const parsed = parseSessionResult(result);

    // Then it comes back unchanged
    expect(parsed).toEqual(result);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'x'],
    ['an array wallet entropy', { session: null, localWallet: { entropy: [1, 2], identity: null } }],
    ['a session lacking its blob', { session: { uiState: null }, localWallet: null }],
    ['a string identity', { session: null, localWallet: { entropy: ENTROPY, identity: 'x' } }],
    ['an array identity', { session: null, localWallet: { entropy: ENTROPY, identity: [] } }],
    [
      'an identity missing its username',
      { session: null, localWallet: { entropy: ENTROPY, identity: { identityAccountId: 'a' } } },
    ],
    ['a non-object session', { session: 'blob', localWallet: null }],
    ['entropy of a wrong length', { session: null, localWallet: { entropy: new Uint8Array(15), identity: null } }],
    ['a session with an empty blob', { session: { blob: '', uiState: null }, localWallet: null }],
    ['a missing session', { localWallet: null }],
  ])('As a page, I hear %s and read it as no result', (_name, value) => {
    // Given a payload that is not a result

    // When it is parsed
    const result = parseSessionResult(value);

    // Then it is null
    expect(result).toBeNull();
  });

  it('As a signed-out window, I send an empty result and a page reads it as no result', () => {
    // Given the sign-out result

    // When a page parses it as a sign-in result
    const result = parseSessionResult(SIGNED_OUT_RESULT);

    // Then it is an empty object and not a sign-in result
    expect(SIGNED_OUT_RESULT).toEqual({});
    expect(result).toBeNull();
  });
});
