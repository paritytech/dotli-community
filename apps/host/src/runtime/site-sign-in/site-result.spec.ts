// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { siteSignInResult } from './site-result.js';

describe('site sign-in result', () => {
  it('As a site, I receive the username of a user who has one and nothing else', () => {
    // Given a full username
    const username = { name: 'alice', kind: 'full' as const };

    // When the result is built
    const result = siteSignInResult(username);

    // Then it carries the username alone
    expect(result).toEqual({ username: { name: 'alice', kind: 'full' } });
  });

  it('As a site, I receive an empty username for a user who has none', () => {
    // Given no username
    const username = null;

    // When the result is built
    const result = siteSignInResult(username);

    // Then its username is empty
    expect(result).toEqual({ username: null });
  });
});
