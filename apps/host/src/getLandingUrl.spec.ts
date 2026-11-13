// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN } from '@dotli/config';
import { describe, expect, it } from 'vitest';
import { getLandingUrl, readLandingName } from './getLandingUrl.js';

describe('getLandingUrl', () => {
  it('As a visitor on the deployed site, I leave for the base domain', () => {
    // Given a deployed page
    const page = { location: { protocol: 'https:', port: '' }, localRoot: null };

    // When the landing address is built
    const url = getLandingUrl(page);

    // Then it is the base domain's root
    expect(url).toBe(`https://${BASE_DOMAIN}/`);
  });

  it('As a developer on a local root, I leave for the local root with its port', () => {
    // Given a page under a local root with a port
    const page = { location: { protocol: 'http:', port: '4001' }, localRoot: 'localhost' };

    // When the landing address is built
    const url = getLandingUrl(page);

    // Then it keeps the port
    expect(url).toBe('http://localhost:4001/');
  });

  it('As a developer on a local root with no port, I leave for the local root without one', () => {
    // Given a page under a local root with an empty port
    const page = { location: { protocol: 'http:', port: '' }, localRoot: 'localhost' };

    // When the landing address is built
    const url = getLandingUrl(page);

    // Then it has no port
    expect(url).toBe('http://localhost/');
  });

  it.each([
    ['doom', '?q=doom'],
    ['two words', '?q=two+words'],
  ])('As a visitor, I search again for %j and the landing address carries it encoded', (name, query) => {
    // Given a deployed page
    const page = { location: { protocol: 'https:', port: '' }, localRoot: null };

    // When the landing address is built with a name
    const url = getLandingUrl(page, name);

    // Then the name is in the query
    expect(url).toBe(`https://${BASE_DOMAIN}/${query}`);
  });
});

describe('readLandingName', () => {
  it('As the landing page, I read the trimmed name from the query', () => {
    // Given a query with a padded name
    const search = '?q=%20doom%20';

    // When the name is read
    const name = readLandingName(search);

    // Then it is trimmed
    expect(name).toBe('doom');
  });

  it.each(['?q=', '?q=%20', ''])('As the landing page, I read no name from %j', search => {
    // Given a query with no usable name

    // When the name is read
    const name = readLandingName(search);

    // Then there is none
    expect(name).toBeNull();
  });
});
