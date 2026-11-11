// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getHostPlace } from './getHostPlace.js';

describe('getHostPlace', () => {
  it("As a user on dotli's own pages, I open the root or a subdomain and it places as the site", () => {
    // Given the root and two subdomains
    const hosts = ['dot.li', 'host.dot.li', 'a.b.dot.li'];

    // When each is placed under dot.li
    const places = hosts.map(host => getHostPlace(host, 'dot.li'));

    // Then all are the site
    expect(places).toEqual(['site', 'site', 'site']);
  });

  it('As a user on a product, I open app or anything under it and it places as a product', () => {
    // Given app and a product under it
    const hosts = ['app.dot.li', 'shop.app.dot.li'];

    // When each is placed under dot.li
    const places = hosts.map(host => getHostPlace(host, 'dot.li'));

    // Then both are products
    expect(places).toEqual(['app', 'app']);
  });

  it('As a user on another site, I open a host that only ends in the root and it places as foreign', () => {
    // Given hosts that only resemble the root
    const hosts = ['evildot.li', 'dot.li.evil.com', 'localhost'];

    // When each is placed under dot.li
    const places = hosts.map(host => getHostPlace(host, 'dot.li'));

    // Then all are foreign
    expect(places).toEqual(['foreign', 'foreign', 'foreign']);
  });
});
