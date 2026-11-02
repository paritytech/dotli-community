// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
  SHARED_CORE_SESSION_KEY,
} from './sharedAuthKeys.js';

describe('shared auth keys', () => {
  it("As the shared auth store, I accept the current shell's site id", () => {
    // Given the current shell's site id. Under Node the config takes the build-time branch and derives as localhost.
    const siteId = SITE_ID;

    // When
    const accepted = isSharedAuthSiteId(siteId);

    // Then
    expect(accepted).toBe(true);
  });

  it('As the shared auth store, I refuse site ids of other root domains', () => {
    // Given
    const siteIds = ['dot.li', 'paseo.li', 'paseoli.dev', 'staging.dot.li', ''];

    // When
    const accepted = siteIds.map(siteId => isSharedAuthSiteId(siteId));

    // Then
    expect(accepted).toEqual([false, false, false, false, false]);
  });

  it('As the shared auth store, I accept well-formed storage keys and refuse path-like, spaced or empty ones', () => {
    // Given
    const keys = ['SsoSessions', 'UserSecrets_abc-123', 'identity_0x1234', '../secrets', 'key with spaces', ''];

    // When
    const accepted = keys.map(key => isValidSharedAuthKey(key));

    // Then
    expect(accepted).toEqual([true, true, true, false, false, false]);
  });

  it('As a returning user, I keep my shared authentication under stable storage keys', () => {
    // Given
    const entries = [
      ['dot.li', SHARED_CORE_SESSION_KEY],
      ['paseoli.dev', SHARED_CORE_SESSION_KEY],
      ['dot.li', 'UserSecrets'],
    ] as const;

    // When
    const storageKeys = entries.map(([siteId, key]) => buildSharedAuthStorageKey(siteId, key));

    // Then
    expect(storageKeys).toEqual(['TRUAPI_dot.li_session', 'TRUAPI_paseoli.dev_session', 'TRUAPI_dot.li_UserSecrets']);
  });
});
