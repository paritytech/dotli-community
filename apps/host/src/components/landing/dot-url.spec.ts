// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { BASE_DOMAIN } from '@dotli/config';
import { dotUrl, typedName } from './dot-url.js';

const DEV = { hostname: 'localhost', protocol: 'http:', port: '5173' };
const SUFFIX = '.dot';

describe('dotUrl', () => {
  it('As a visitor who types a valid name, with or without the TLD, I am taken to its site', () => {
    // Given / When / Then
    expect(dotUrl(typedName(`  Mark3t${SUFFIX} `, SUFFIX), DEV)).toBe('http://mark3t.localhost:5173');
    expect(dotUrl(typedName('mark3t', SUFFIX), DEV)).toBe('http://mark3t.localhost:5173');
  });

  it('As a developer on a name subdomain of localhost, a name takes me to its own localhost subdomain', () => {
    // Given
    const page = { hostname: 'alpha.localhost', protocol: 'http:', port: '5173' };

    // When / Then
    expect(dotUrl('beta', page)).toBe('http://beta.localhost:5173');
  });

  it('As a visitor on the live site, a valid name takes me to its subdomain of the base domain', () => {
    // Given
    const live = { hostname: 'dot.li', protocol: 'https:', port: '' };

    // When / Then
    expect(dotUrl('playground', live)).toBe(`https://playground.${BASE_DOMAIN}`);
  });
});
