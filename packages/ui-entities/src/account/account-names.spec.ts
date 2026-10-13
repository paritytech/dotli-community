// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { sessionDisplayName, sessionInitials, sessionUsername, shortenAccount } from './account-names.js';

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

  it('As a user with a bare session, I get no name and no address, since too short a value is not shortened', () => {
    // Given
    const bare = {};

    // When
    const name = sessionDisplayName(bare);

    // Then
    expect(name).toBeUndefined();
    expect(shortenAccount('0x0102')).toBeUndefined();
  });
});
