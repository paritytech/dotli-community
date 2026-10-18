// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  SHARED_CORE_SESSION_KEY,
} from './auth-storage.js';

describe('shared auth storage helpers', () => {
  it('As the shared auth store, I serve host shell origins and refuse product origins', () => {
    // When / Then
    expect(isSharedAuthOriginAllowed('https://dot.li')).toBe(true);
    expect(isSharedAuthOriginAllowed('https://browse.dot.li')).toBe(true);
    expect(isSharedAuthOriginAllowed('https://host-playground.dot.li')).toBe(true);
    expect(isSharedAuthOriginAllowed('https://host.dot.li')).toBe(true);

    expect(isSharedAuthOriginAllowed('https://bafy.app.dot.li')).toBe(false);
    expect(isSharedAuthOriginAllowed('https://app.dot.li')).toBe(false);
    expect(isSharedAuthOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('As the shared auth store in development, I serve localhost host shells and refuse localhost product origins', () => {
    // When / Then
    expect(isSharedAuthOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isSharedAuthOriginAllowed('http://browse.localhost:5173')).toBe(true);
    expect(isSharedAuthOriginAllowed('http://host.localhost:5173')).toBe(true);

    expect(isSharedAuthOriginAllowed('http://bafy.app.localhost:5173')).toBe(false);
  });

  it("As the shared auth store, I accept the current shell's site id", () => {
    // Given
    // Under Node the config takes the build-time branch and derives as localhost, so `SITE_ID` is "local.li".
    expect(SITE_ID).toBe('local.li');

    // When / Then
    expect(isSharedAuthSiteId(SITE_ID)).toBe(true);
  });

  it('As the shared auth store, I refuse site ids of other root domains', () => {
    // When / Then
    expect(isSharedAuthSiteId('dot.li')).toBe(false);
    expect(isSharedAuthSiteId('paseo.li')).toBe(false);
    expect(isSharedAuthSiteId('paseoli.dev')).toBe(false);
    expect(isSharedAuthSiteId('staging.dot.li')).toBe(false);
    expect(isSharedAuthSiteId('')).toBe(false);
  });

  it('As the shared auth store, I accept well-formed storage keys and refuse path-like, spaced or empty ones', () => {
    // When / Then
    expect(isValidSharedAuthKey('SsoSessions')).toBe(true);
    expect(isValidSharedAuthKey('UserSecrets_abc-123')).toBe(true);
    expect(isValidSharedAuthKey('identity_0x1234')).toBe(true);
    expect(isValidSharedAuthKey('../secrets')).toBe(false);
    expect(isValidSharedAuthKey('key with spaces')).toBe(false);
    expect(isValidSharedAuthKey('')).toBe(false);
  });

  it('As a returning user, my shared authentication uses stable storage keys', () => {
    // When / Then
    expect(buildSharedAuthStorageKey('dot.li', SHARED_CORE_SESSION_KEY)).toBe('TRUAPI_dot.li_session');
    expect(buildSharedAuthStorageKey('paseoli.dev', SHARED_CORE_SESSION_KEY)).toBe('TRUAPI_paseoli.dev_session');
    expect(buildSharedAuthStorageKey('dot.li', 'UserSecrets')).toBe('TRUAPI_dot.li_UserSecrets');
  });

  it('As the protocol frame, I route the shared auth methods to the auth store and nothing else', () => {
    // Given
    const auth = ['authRead', 'authWrite', 'authClear'] as const;

    // When
    const routed = auth.map(method => isSharedAuthRequestMethod(method));

    // Then
    expect(routed).toEqual([true, true, true]);
    expect(isSharedAuthRequestMethod('authChanges')).toBe(false);
    expect(isSharedAuthRequestMethod('modeRead')).toBe(false);
  });

  it('As the protocol frame, I route the shared mode methods to the mode store and nothing else', () => {
    // Given
    const mode = ['modeRead', 'modeWrite', 'modeClear'] as const;

    // When
    const routed = mode.map(method => isSharedModeRequestMethod(method));

    // Then
    expect(routed).toEqual([true, true, true]);
    expect(isSharedModeRequestMethod('authRead')).toBe(false);
    expect(isSharedModeRequestMethod('authChanges')).toBe(false);
  });
});
