// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
  SHARED_CORE_SESSION_KEY,
} from '../src/auth-storage.js';

describe('shared auth storage helpers', () => {
  it('accepts host shell origins and rejects app origins', () => {
    expect(isSharedAuthOriginAllowed('https://dot.li')).toBe(true);
    expect(isSharedAuthOriginAllowed('https://browse.dot.li')).toBe(true);
    expect(isSharedAuthOriginAllowed('https://host-playground.dot.li')).toBe(true);
    expect(isSharedAuthOriginAllowed('https://host.dot.li')).toBe(true);

    expect(isSharedAuthOriginAllowed('https://bafy.app.dot.li')).toBe(false);
    expect(isSharedAuthOriginAllowed('https://app.dot.li')).toBe(false);
    expect(isSharedAuthOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('accepts localhost host shells and rejects localhost app origins', () => {
    expect(isSharedAuthOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isSharedAuthOriginAllowed('http://browse.localhost:5173')).toBe(true);
    expect(isSharedAuthOriginAllowed('http://host.localhost:5173')).toBe(true);

    expect(isSharedAuthOriginAllowed('http://bafy.app.localhost:5173')).toBe(false);
  });

  it("accepts only the current shell's SITE_ID", () => {
    // happy-dom's hostname is localhost, so `SITE_ID` is "local.li".
    expect(SITE_ID).toBe('local.li');
    expect(isSharedAuthSiteId(SITE_ID)).toBe(true);
  });

  it('rejects siteIds belonging to unrelated root domains', () => {
    expect(isSharedAuthSiteId('dot.li')).toBe(false);
    expect(isSharedAuthSiteId('paseo.li')).toBe(false);
    expect(isSharedAuthSiteId('paseoli.dev')).toBe(false);
    expect(isSharedAuthSiteId('staging.dot.li')).toBe(false);
    expect(isSharedAuthSiteId('')).toBe(false);
  });

  it('validates storage keys', () => {
    expect(isValidSharedAuthKey('SsoSessions')).toBe(true);
    expect(isValidSharedAuthKey('UserSecrets_abc-123')).toBe(true);
    expect(isValidSharedAuthKey('identity_0x1234')).toBe(true);
    expect(isValidSharedAuthKey('../secrets')).toBe(false);
    expect(isValidSharedAuthKey('key with spaces')).toBe(false);
    expect(isValidSharedAuthKey('')).toBe(false);
  });

  it('As a returning user, my shared authentication uses stable storage keys', () => {
    expect(buildSharedAuthStorageKey('dot.li', SHARED_CORE_SESSION_KEY)).toBe('TRUAPI_dot.li_session');
    expect(buildSharedAuthStorageKey('paseoli.dev', SHARED_CORE_SESSION_KEY)).toBe('TRUAPI_paseoli.dev_session');
    expect(buildSharedAuthStorageKey('dot.li', 'UserSecrets')).toBe('TRUAPI_dot.li_UserSecrets');
  });

  it('identifies shared-auth RPC methods', () => {
    expect(isSharedAuthRequestMethod('authStorageRead')).toBe(true);
    expect(isSharedAuthRequestMethod('authStorageWrite')).toBe(true);
    expect(isSharedAuthRequestMethod('authStorageClear')).toBe(true);
    expect(isSharedAuthRequestMethod('warmup')).toBe(false);
  });
});
