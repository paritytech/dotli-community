// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseSessionResult } from './parseSessionResult.js';
import { SIGNED_OUT_RESULT } from './roundAnswer.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

describe('session results', () => {
  it.each([
    { name: 'no session and no wallet', value: { session: null, localWallet: null } },
    {
      name: 'a session and a wallet',
      value: { session: { blob: 'b', uiState: null }, localWallet: { entropy: ENTROPY, identity: null } },
    },
  ])('As a user signing in on a dot.li page, I get a result with $name and the page reads it unchanged', row => {
    // Given a well formed result
    const { value } = row;

    // When it is parsed
    const result = parseSessionResult(value);

    // Then it comes back unchanged
    expect(result).toEqual(value);
  });

  it.each<{ name: string; value: unknown }>([
    { name: 'null', value: null },
    { name: 'a string', value: 'x' },
    {
      name: 'an array wallet entropy',
      value: { session: null, localWallet: { entropy: [1, 2], identity: null } },
    },
    { name: 'a session lacking its blob', value: { session: { uiState: null }, localWallet: null } },
    { name: 'a string identity', value: { session: null, localWallet: { entropy: ENTROPY, identity: 'x' } } },
    { name: 'an array identity', value: { session: null, localWallet: { entropy: ENTROPY, identity: [] } } },
    {
      name: 'an identity missing its username',
      value: { session: null, localWallet: { entropy: ENTROPY, identity: { identityAccountId: 'a' } } },
    },
    { name: 'a non-object session', value: { session: 'blob', localWallet: null } },
    {
      name: 'entropy of a wrong length',
      value: { session: null, localWallet: { entropy: new Uint8Array(15), identity: null } },
    },
    { name: 'a session with an empty blob', value: { session: { blob: '', uiState: null }, localWallet: null } },
    { name: 'a missing session', value: { localWallet: null } },
  ])('As a user signing in on a dot.li page, I get $name and the page reads it as no result', row => {
    // Given a payload that is not a result
    const { value } = row;

    // When it is parsed
    const result = parseSessionResult(value);

    // Then it is null
    expect(result).toBeNull();
  });

  it('As a user signing out in the sign-out window, I send an empty result and a page reads it as no result', () => {
    // Given the sign-out result
    const value = SIGNED_OUT_RESULT;

    // When a page parses it as a sign-in result
    const result = parseSessionResult(value);

    // Then it is an empty object and not a sign-in result
    expect(value).toEqual({});
    expect(result).toBeNull();
  });
});
