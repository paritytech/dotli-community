// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  parseOpenerMessage,
  parseWindowMessage,
  signInWindowUrl,
  signOutWindowUrl,
  windowUrlIntent,
  windowUrlSignOut,
  type OpenerMessage,
  type WindowMessage,
} from './messages.js';

/** A result message with `result` as its body. */
const res = (result: unknown) => ({ type: 'dotli:session:result', round: 'r', result });

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

describe('session handoff messages', () => {
  it.each<WindowMessage>([
    { type: 'dotli:session:ready' },
    { type: 'dotli:session:signed-out-read' },
    { type: 'dotli:session:result', round: 'r1', result: { session: null, localWallet: null } },
    {
      type: 'dotli:session:result',
      round: 'r1',
      result: { session: { blob: 'b', uiState: null }, localWallet: { entropy: ENTROPY, identity: null } },
    },
    { type: 'dotli:session:refused', round: 'r1' },
  ])('As a product page, I hear a window message of type $type and parse it back unchanged', message => {
    // Given a well formed window message
    // When it is parsed
    const parsed = parseWindowMessage(message);

    // Then it comes back unchanged
    expect(parsed).toEqual(message);
  });

  it.each<OpenerMessage>([
    { type: 'dotli:session:hello', round: 'r1', intent: 'signin' },
    { type: 'dotli:session:hello', round: 'r1', intent: 'phrase' },
    { type: 'dotli:session:hello', round: 'r1', intent: 'resume' },
  ])('As a user in the sign-in window, I open it with intent $intent and its hello parses back unchanged', message => {
    // Given a well formed hello
    // When it is parsed
    const parsed = parseOpenerMessage(message);

    // Then it comes back unchanged
    expect(parsed).toEqual(message);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'dotli:session:ready'],
    ['an unknown type', { type: 'dotli:session:other' }],
    ['a result without a round', { type: 'dotli:session:result', result: { session: null, localWallet: null } }],
    [
      'a result with a numeric round',
      { type: 'dotli:session:result', round: 1, result: { session: null, localWallet: null } },
    ],
    ['a result without a result', { type: 'dotli:session:result', round: 'r' }],
    [
      'a result with array entropy',
      {
        type: 'dotli:session:result',
        round: 'r',
        result: { session: null, localWallet: { entropy: [1, 2], identity: null } },
      },
    ],
    [
      'a result with a session lacking its blob',
      { type: 'dotli:session:result', round: 'r', result: { session: { uiState: null }, localWallet: null } },
    ],
    ['a string identity', res({ session: null, localWallet: { entropy: ENTROPY, identity: 'x' } })],
    ['an array identity', res({ session: null, localWallet: { entropy: ENTROPY, identity: [] } })],
    [
      'an identity missing its username',
      res({ session: null, localWallet: { entropy: ENTROPY, identity: { identityAccountId: 'a' } } }),
    ],
    ['entropy of a wrong length', res({ session: null, localWallet: { entropy: new Uint8Array(15), identity: null } })],
    ['a non-object session', res({ session: 'blob', localWallet: null })],
    ['a session with an empty blob', res({ session: { blob: '', uiState: null }, localWallet: null })],
    ['a refusal without a round', { type: 'dotli:session:refused' }],
    ['a refusal with a non-string round', { type: 'dotli:session:refused', round: {} }],
    ['a cancel, which the window does not send', { type: 'dotli:session:cancelled', round: 'r1' }],
    ['a hello message', { type: 'dotli:session:hello', round: 'r', intent: 'signin' }],
  ])('As a product page, I hear %s and ignore it as no window message', (_name, data) => {
    // Given a payload that is not a window message
    // When it is parsed
    // Then it is null
    expect(parseWindowMessage(data)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['an unknown intent', { type: 'dotli:session:hello', round: 'r', intent: 'signout' }],
    ['a missing intent', { type: 'dotli:session:hello', round: 'r' }],
    ['a missing round', { type: 'dotli:session:hello', intent: 'signin' }],
    ['a wrong type', { type: 'dotli:session:ready' }],
  ])('As a user in the sign-in window, I open it and %s is ignored as no hello', (_name, data) => {
    // Given a payload that is not a hello
    // When it is parsed
    // Then it is null
    expect(parseOpenerMessage(data)).toBeNull();
  });
});

describe('signInWindowUrl', () => {
  const ORIGIN = 'https://dot.li';

  it('As a product page, I open the sign-in window and its URL carries the intent and network', () => {
    // Given an intent and a network
    // When the URL is built
    const url = new URL(signInWindowUrl('signin', 'paseo-next-v2', ORIGIN));

    // Then it targets the session path on the root origin
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/__session');
    expect(url.searchParams.get('intent')).toBe('signin');
    expect(url.searchParams.get('net')).toBe('paseo-next-v2');
    expect(url.searchParams.has('notified')).toBe(false);
    expect(url.searchParams.has('network')).toBe(false);
  });
});

describe('signOutWindowUrl', () => {
  it('As a product page in paired mode, I open the sign-out window and its URL marks that I already told the phone', () => {
    // Given a sign-out that was notified
    // When the URL is built
    const url = new URL(signOutWindowUrl(true, 'paseo-next-v2', 'http://localhost:4321'));

    // Then notified=1 is present and the origin is the local one
    expect(url.origin).toBe('http://localhost:4321');
    expect(url.searchParams.get('notified')).toBe('1');
    expect(url.searchParams.get('intent')).toBe('signout');
  });
});

describe('windowUrlIntent', () => {
  it('As a user in a sign-in window with no opener, I open it and start on the phrase view only when its URL asks for it', () => {
    // Given window URLs with each intent
    const searches = [
      '?intent=phrase&net=paseo-next-v2',
      '?intent=signin',
      '?intent=signout',
      '?intent=other',
      '',
      '?intent=resume',
    ];

    // When each URL's intent is read
    const intents = searches.map(search => windowUrlIntent(search));

    // Then only the phrase intent opens the phrase view
    expect(intents).toEqual(['phrase', 'signin', 'signin', 'signin', 'signin', 'signin']);
  });
});

describe('windowUrlSignOut', () => {
  it('As a user in the sign-out window, I open it and its URL tells whether the page already told the phone', () => {
    // Given sign-out URLs with and without a valid notified mark
    const searches = [
      '?intent=signout&net=paseo-next-v2&notified=1',
      '?intent=signout&net=paseo-next-v2',
      '?intent=signout&notified=yes',
    ];

    // When each URL's sign-out is read
    const signOuts = searches.map(search => windowUrlSignOut(search));

    // Then only notified=1 marks the phone told
    expect(signOuts).toEqual([{ notified: true }, { notified: false }, { notified: false }]);
  });

  it('As a user in the sign-in window, I open it and its URL names no sign-out', () => {
    // Given sign-in and phrase URLs
    const searches = ['?intent=signin&notified=1', '?intent=phrase', ''];

    // When each URL's sign-out is read
    const signOuts = searches.map(search => windowUrlSignOut(search));

    // Then none names a sign-out
    expect(signOuts).toEqual([null, null, null]);
  });
});
