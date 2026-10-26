// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  offeredAccountName,
  sessionDisplayName,
  sessionInitials,
  sessionUsername,
  shortenAccount,
} from './account-names.js';

const PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

describe('account names', () => {
  it('As a logged-in user with a full name, my badge shows the initials of my first two names', () => {
    // Given
    const session = { fullUsername: 'ada  lovelace king' };

    // When
    const initials = sessionInitials(session);

    // Then
    expect(initials).toBe('AL');
  });

  it('As a logged-in user with one name or only a lite username, my badge shows its first two letters', () => {
    // Given
    const oneName = { fullUsername: 'alice' };
    const lite = { liteUsername: 'pgherveou.04' };

    // When
    const initials = [sessionInitials(oneName), sessionInitials(lite)];

    // Then
    expect(initials).toEqual(['AL', 'PG']);
  });

  it('As a logged-in user without a username, my badge has no initials, never ones taken from my address', () => {
    // Given
    const session = { publicKey: PUBLIC_KEY, fullUsername: '' };

    // When
    const initials = sessionInitials(session);

    // Then
    expect(initials).toBeUndefined();
  });

  it('As a user whose account has no username, I see my shortened address instead', () => {
    // Given
    const session = { publicKey: PUBLIC_KEY };

    // When
    const name = sessionDisplayName(session);

    // Then
    expect(sessionUsername(session)).toBeUndefined();
    expect(name).toBe('0x000102...1e1f');
  });

  it('As a user with a username, my username wins over my address, primary first', () => {
    // Given
    const session = {
      publicKey: PUBLIC_KEY,
      primaryUsername: 'alice',
      fullUsername: 'Alice Smith',
      liteUsername: 'alice.01',
    };

    // When
    const name = sessionDisplayName(session);

    // Then
    expect(name).toBe('alice');
  });

  it('As a user with a bare session, I get no name', () => {
    // Given
    const bare = {};

    // When
    const name = sessionDisplayName(bare);

    // Then
    expect(name).toBeUndefined();
  });

  it('As a user with a short account value, I get no shortened address', () => {
    // When
    const shortened = shortenAccount('0x0102');

    // Then
    expect(shortened).toBeUndefined();
  });

  it('As a user in the sign-in window, I am offered a wallet with no identity and see the generic label', () => {
    // Given a stored local wallet with no identity
    const offer = { wallet: 'local' as const, account: null };

    // When its name is read for Continue
    const name = offeredAccountName(offer);

    // Then the generic label shows
    expect(name).toBe('Recovery phrase wallet');
  });

  it('As a user in the sign-in window, I am offered a stored wallet or session with names and see those names', () => {
    // Given a local wallet with a username and a paired session with a public key
    const wallet = { wallet: 'local' as const, account: { liteUsername: 'bob.02' } };
    const session = { wallet: 'paired' as const, account: { publicKey: PUBLIC_KEY } };

    // When both names are read for Continue
    const names = [offeredAccountName(wallet), offeredAccountName(session)];

    // Then the username and the shortened key show
    expect(names).toEqual(['bob.02', '0x000102...1e1f']);
  });

  it('As a user in the sign-in window, I am offered a paired session with no cached names and see that it is Polkadot App', () => {
    // Given a paired session with no cached account
    const offer = { wallet: 'paired' as const, account: null };

    // When its name is read for Continue
    const name = offeredAccountName(offer);

    // Then the Polkadot App label shows
    expect(name).toBe('Polkadot App account');
  });
});
