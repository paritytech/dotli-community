// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import {
  buildSharedAuthStorageKey,
  isSharedAuthOriginAllowed,
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

    expect(isSharedAuthOriginAllowed('https://bafy.app.dot.li')).toBe(false);
    expect(isSharedAuthOriginAllowed('https://app.dot.li')).toBe(false);
    expect(isSharedAuthOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('As a page on host.<domain>, I open the frame and am admitted as a parent alongside product hosts', () => {
    // Given host.<domain> deployed and on localhost
    const origins = ['https://host.dot.li', 'http://host.localhost:5173'];

    // When each asks for the shared auth store
    const allowed = origins.map(origin => isSharedAuthOriginAllowed(origin));

    // Then both are admitted
    expect(allowed).toEqual([true, true]);
  });

  it('As the shared auth store in development, I serve localhost host shells and refuse localhost product origins', () => {
    // When / Then
    expect(isSharedAuthOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isSharedAuthOriginAllowed('http://browse.localhost:5173')).toBe(true);

    expect(isSharedAuthOriginAllowed('http://bafy.app.localhost:5173')).toBe(false);
  });

  it('As a developer on local.host, I reach the shared auth store from a host shell and am served while a product origin is refused', () => {
    // Given two host shells, two product origins and a lookalike, all in development on local.host
    const shells = ['https://local.host:4321', 'https://browse.local.host:4321'];
    const others = ['https://bafy.app.local.host:4322', 'https://app.local.host:4321', 'http://notlocal.host'];

    // When each asks for the shared auth store
    const shellsAllowed = shells.map(origin => isSharedAuthOriginAllowed(origin, true));
    const othersAllowed = others.map(origin => isSharedAuthOriginAllowed(origin, true));

    // Then only the host shells are served
    expect(shellsAllowed).toEqual([true, true]);
    expect(othersAllowed).toEqual([false, false, false]);
  });

  it('As a user of a production build, I reach the shared auth store and every local.host origin is refused while localhost is served', () => {
    // Given local.host and localhost origins in a production build
    const localHost = ['https://local.host:4321', 'https://browse.local.host:4321', 'http://browse.local.host:5173'];
    const localhost = ['http://localhost:5173', 'http://browse.localhost:5173'];

    // When each asks for the shared auth store
    const localHostAllowed = localHost.map(origin => isSharedAuthOriginAllowed(origin, false));
    const localhostAllowed = localhost.map(origin => isSharedAuthOriginAllowed(origin, false));

    // Then every local.host origin is refused and localhost is served
    expect(localHostAllowed).toEqual([false, false, false]);
    expect(localhostAllowed).toEqual([true, true]);
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
