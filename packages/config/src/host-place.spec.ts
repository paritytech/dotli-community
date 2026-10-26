// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hostPlace, isSiteOrigin, localRootOf } from './host-place.js';

describe('hostPlace', () => {
  it("As a user on dotli's own pages, I open the root or a subdomain and it places as the site", () => {
    // Given the root and two subdomains
    const hosts = ['dot.li', 'host.dot.li', 'a.b.dot.li'];

    // When each is placed under dot.li
    const places = hosts.map(host => hostPlace(host, 'dot.li'));

    // Then all are the site
    expect(places).toEqual(['site', 'site', 'site']);
  });

  it('As a user on a product, I open app or anything under it and it places as a product', () => {
    // Given app and a product under it
    const hosts = ['app.dot.li', 'shop.app.dot.li'];

    // When each is placed under dot.li
    const places = hosts.map(host => hostPlace(host, 'dot.li'));

    // Then both are products
    expect(places).toEqual(['app', 'app']);
  });

  it('As a user on another site, I open a host that only ends in the root and it places as foreign', () => {
    // Given hosts that only resemble the root
    const hosts = ['evildot.li', 'dot.li.evil.com', 'localhost'];

    // When each is placed under dot.li
    const places = hosts.map(host => hostPlace(host, 'dot.li'));

    // Then all are foreign
    expect(places).toEqual(['foreign', 'foreign', 'foreign']);
  });

  it('As a developer on localhost, I open localhost hosts and localhost stands for the root', () => {
    // Given localhost hosts and a lookalike
    const hosts = ['localhost', 'host.localhost', 'app.localhost', 'shop.app.localhost', 'notlocalhost'];

    // When each is placed under localhost
    const places = hosts.map(host => hostPlace(host, 'localhost'));

    // Then the root and its subdomains are the site, app hosts products and the lookalike foreign
    expect(places).toEqual(['site', 'site', 'app', 'app', 'foreign']);
  });

  it('As a developer on local.host, I open local.host hosts and local.host stands for the root', () => {
    // Given local.host hosts and a lookalike
    const hosts = ['local.host', 'browse.local.host', 'app.local.host', 'shop.app.local.host', 'notlocal.host'];

    // When each is placed under local.host
    const places = hosts.map(host => hostPlace(host, 'local.host'));

    // Then the root and its subdomains are the site, app hosts products and the lookalike foreign
    expect(places).toEqual(['site', 'site', 'app', 'app', 'foreign']);
  });
});

describe('localRootOf', () => {
  it('As a developer on a local page in a development build, I open a host and learn which local root it sits under', () => {
    // Given hosts under both local roots
    const hosts = ['localhost', 'browse.localhost', 'shop.app.localhost', 'local.host', 'browse.local.host'];

    // When each local root is read in a development build
    const roots = hosts.map(host => localRootOf(host, true));

    // Then each host names its own root
    expect(roots).toEqual(['localhost', 'localhost', 'localhost', 'local.host', 'local.host']);
  });

  it('As a user of a production build, I open a local host and localhost is a local root while the public local.host is not', () => {
    // Given hosts under both local roots
    const hosts = ['localhost', 'browse.localhost', 'local.host', 'browse.local.host', 'shop.app.local.host'];

    // When each local root is read in a production build
    const roots = hosts.map(host => localRootOf(host, false));

    // Then only the localhost hosts have one
    expect(roots).toEqual(['localhost', 'localhost', null, null, null]);
  });

  it('As a user on a deployed page, I open a host off every local root and it has none', () => {
    // Given deployed hosts and lookalikes
    const hosts = ['dot.li', 'browse.dot.li', 'notlocalhost', 'notlocal.host', 'local.host.evil.com', '127.0.0.1'];

    // When each local root is read
    const roots = hosts.map(host => localRootOf(host, true));

    // Then none has one
    expect(roots).toEqual([null, null, null, null, null, null]);
  });
});

describe('isSiteOrigin', () => {
  it("As a page of dotli's own on the root or a subdomain over https, I ask the check and am admitted", () => {
    // Given the root and a subdomain over https
    const origins = ['https://dot.li', 'https://browse.dot.li'];

    // When each is checked under dot.li
    const answers = origins.map(origin => isSiteOrigin(origin, 'dot.li', false));

    // Then both are admitted
    expect(answers).toEqual([true, true]);
  });

  it('As a product under app., I ask the check and am refused', () => {
    // Given app and a product under it
    const origins = ['https://app.dot.li', 'https://foo.app.dot.li'];

    // When each is checked under dot.li
    const answers = origins.map(origin => isSiteOrigin(origin, 'dot.li', false));

    // Then both are refused
    expect(answers).toEqual([false, false]);
  });

  it('As a page on a local root over http, I ask the check and am admitted', () => {
    // Given a local origin over http
    const origin = 'http://localhost:4321';

    // When it is checked with dev off
    const answer = isSiteOrigin(origin, 'dot.li', false);

    // Then it is admitted
    expect(answer).toBe(true);
  });

  it('As a developer on local.host, I ask the check and am admitted over http only in a development build', () => {
    // Given a local.host origin over http
    const origin = 'http://local.host:4321';

    // When it is checked with dev on and with dev off
    const answers = [true, false].map(dev => isSiteOrigin(origin, 'dot.li', dev));

    // Then it is admitted in the development build and refused in the other
    expect(answers).toEqual([true, false]);
  });

  it('As a page off every root or over http off a local root, I ask the check and am refused', () => {
    // Given a foreign origin, the root over http and a string that is no url
    const origins = ['https://evil.example', 'http://dot.li', 'not a url'];

    // When each is checked under dot.li
    const answers = origins.map(origin => isSiteOrigin(origin, 'dot.li', false));

    // Then all are refused
    expect(answers).toEqual([false, false, false]);
  });
});
