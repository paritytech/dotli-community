// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { BASE_DOMAIN } from './baseDomain.js';
import { isSandboxOrigin } from './isSandboxOrigin.js';

// Gates the postMessage traffic the host accepts from the sandbox iframe.
describe('isSandboxOrigin', () => {
  it.each([
    `https://name.app.${BASE_DOMAIN}`,
    `https://my-app.app.${BASE_DOMAIN}`,
    'http://name.app.localhost:5174',
    'http://app.localhost',
    'https://name.app.local.host:4322',
    'https://app.local.host',
  ])('As the host, I check %s and accept it as a sandbox origin', origin => {
    // When
    const accepted = isSandboxOrigin(origin);

    // Then
    expect(accepted).toBe(true);
  });

  it.each([
    `https://name.${BASE_DOMAIN}`,
    `https://app.${BASE_DOMAIN}`,
    `https://${BASE_DOMAIN}`,
    `http://name.app.${BASE_DOMAIN}`,
    'https://evil.com',
    `https://name.app.${BASE_DOMAIN}.evil.com`,
    `https://evil-app.${BASE_DOMAIN}`,
    'http://name.localhost:5174',
    'http://localhost:5174',
    'https://browse.local.host:4321',
    'https://local.host:4321',
    'https://name.app.notlocal.host',
    'garbage',
    '',
    `name.app.${BASE_DOMAIN}`,
  ])('As the host, I check %j and refuse it as a sandbox origin without throwing', origin => {
    // When
    const accepted = isSandboxOrigin(origin);

    // Then
    expect(accepted).toBe(false);
  });
});
