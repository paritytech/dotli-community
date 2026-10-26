// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { siteSignInResult } from './site-result.js';

describe('site sign-in result', () => {
  it('As a site, I receive the exact result keys and a lowercase 0x hex public key', () => {
    // Given the signed assertion of a full username
    const input = {
      username: { name: 'alice.dot', kind: 'full' as const },
      address: '5Grw',
      publicKey: new Uint8Array([0xab, 0x00, 0xff, 0x0c]),
      message: 'text',
      signature: '0xdeadbeef',
    };

    // When the result is built
    const result = siteSignInResult(input);

    // Then it has exactly the documented shape
    expect(Object.keys(result)).toEqual(['username', 'address', 'public_key', 'assertion']);
    expect(Object.keys(result.assertion)).toEqual(['message', 'signature']);
    expect(result).toEqual({
      username: { name: 'alice.dot', kind: 'full' },
      address: '5Grw',
      public_key: '0xab00ff0c',
      assertion: { message: 'text', signature: '0xdeadbeef' },
    });
  });
});
