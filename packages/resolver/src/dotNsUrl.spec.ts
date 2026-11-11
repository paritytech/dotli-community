// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, onTestFinished } from 'vitest';
import { getSettings, setSettings } from '@dotli/config';
import { dotNsUrl } from './dotNsUrl.js';

describe('parseDotNsDomain', () => {
  it.each([
    [
      'a bare .paseo name',
      'it opens as that product',
      'mytestapp.paseo',
      { identifier: 'mytestapp.paseo', pathname: '' },
    ],
    [
      'a .paseo name after https://',
      'it opens as that product',
      'https://mytestapp.paseo',
      { identifier: 'mytestapp.paseo', pathname: '' },
    ],
    [
      'a .paseo name after http://',
      'it opens as that product',
      'http://mytestapp.paseo',
      { identifier: 'mytestapp.paseo', pathname: '' },
    ],
    [
      'a .paseo name with a path',
      'it opens at that path',
      'mytestapp.paseo/some/path',
      { identifier: 'mytestapp.paseo', pathname: 'some/path' },
    ],
    [
      'a .paseo name with only a query',
      'it opens with that query',
      'pr508.faucet.paseo?embed=1',
      { identifier: 'pr508.faucet.paseo', pathname: '?embed=1' },
    ],
    [
      'a .paseo name after https:// with only a query',
      'it opens with that query',
      'https://pr508.faucet.paseo?embed=1',
      { identifier: 'pr508.faucet.paseo', pathname: '?embed=1' },
    ],
    [
      'a .paseo name with only a hash',
      'it opens with that hash',
      'pr508.faucet.paseo#section=main',
      { identifier: 'pr508.faucet.paseo', pathname: '#section=main' },
    ],
    [
      'a .paseo name with a path, query and hash',
      'it opens with all three',
      'pr508.faucet.paseo/nested/path?embed=1#frame=compact',
      { identifier: 'pr508.faucet.paseo', pathname: 'nested/path?embed=1#frame=compact' },
    ],
    [
      'a polkadot:// URL on a .paseo host',
      'it opens as that product',
      'polkadot://currenthost.paseo/mytestapp.paseo',
      { identifier: 'currenthost.paseo', pathname: 'mytestapp.paseo' },
    ],
    [
      'a polkadot:// URL on a .paseo host with a path',
      'it opens at that path',
      'polkadot://currenthost.paseo/mytestapp.paseo/settings',
      { identifier: 'currenthost.paseo', pathname: 'mytestapp.paseo/settings' },
    ],
    [
      'a polkadot:// URL on a .paseo host with a query and hash',
      'it opens with both',
      'polkadot://currenthost.paseo/mytestapp.paseo?embed=1#frame=compact',
      { identifier: 'currenthost.paseo', pathname: 'mytestapp.paseo?embed=1#frame=compact' },
    ],
    [
      'a polkadot:// URL on a .paseo host with a plain path',
      'it opens at that path',
      'polkadot://currenthost.paseo/settings',
      { identifier: 'currenthost.paseo', pathname: 'settings' },
    ],
    [
      'a .paseo subname with a path',
      'it opens as that product at that path',
      'sub.acme.paseo/path',
      { identifier: 'sub.acme.paseo', pathname: 'path' },
    ],
    [
      'a .paseo name with spaces around it',
      'the spaces are ignored',
      '  mytestapp.paseo/path  ',
      { identifier: 'mytestapp.paseo', pathname: 'path' },
    ],
    [
      'a polkadot:// URL in capitals',
      'it opens as the lowercase product',
      'polkadot://MyApp.PASEO/x',
      { identifier: 'myapp.paseo', pathname: 'x' },
    ],
  ])('As a visitor, I type %s and %s', (_typed, _outcome, input, expected) => {
    // When
    const parsed = dotNsUrl.parseDotNsDomain(input);

    // Then
    expect(parsed).toEqual(expected);
  });

  it.each([
    ['a .dot.li domain', 'it is a regular website, not a product', 'mytestapp.dot.li'],
    ['a .dot.li domain with a path', 'it is a regular website', 'mytestapp.dot.li/some/path'],
    ['a polkadot:// URL on a .dot.li host', 'it is not a product', 'polkadot://currenthost.dot.li/mytestapp.paseo'],
    ['a polkadot:// URL on another host', 'it is not a product', 'polkadot://example.com/settings'],
    ['a .dot.li URL with a protocol', 'it is a regular website', 'https://mytestapp.dot.li/path?q=1'],
    ['a localhost address', 'it is not a .paseo product', 'localhost:3000/path'],
    ['an http://localhost URL', 'it is not a .paseo product', 'http://localhost:3000/path'],
    ['a domain of another TLD', 'it is not a product', 'example.com'],
    ['nothing', 'no product opens', ''],
    ['only spaces', 'no product opens', '   '],
  ])('As a visitor, I type %s and %s', (_typed, _outcome, input) => {
    // When
    const parsed = dotNsUrl.parseDotNsDomain(input);

    // Then
    expect(parsed).toBeNull();
  });
});

describe('parseLocalhostUrl', () => {
  it.each([
    ['localhost with a port', 'it opens that local server', 'localhost:3000', { host: 'localhost:3000', pathname: '' }],
    [
      'localhost with a port and path',
      'it opens that path',
      'localhost:3000/some/path',
      { host: 'localhost:3000', pathname: 'some/path' },
    ],
    [
      'http://localhost with a port',
      'it opens that local server',
      'http://localhost:5000',
      { host: 'localhost:5000', pathname: '' },
    ],
    [
      'http://localhost with a port and path',
      'it opens that path',
      'http://localhost:5000/path',
      { host: 'localhost:5000', pathname: 'path' },
    ],
    [
      'localhost with a query and hash',
      'it opens with both',
      'localhost:3000/path?q=1#h',
      { host: 'localhost:3000', pathname: 'path?q=1#h' },
    ],
    ['bare localhost', 'it opens that local server', 'localhost', { host: 'localhost', pathname: '' }],
    [
      'localhost with a path and no port',
      'it opens that path',
      'localhost/path',
      { host: 'localhost', pathname: 'path' },
    ],
    [
      'http://localhost with a path and no port',
      'it opens that path',
      'http://localhost/path',
      { host: 'localhost', pathname: 'path' },
    ],
  ])('As a developer, I type %s and %s', (_typed, _outcome, input, expected) => {
    // When
    const parsed = dotNsUrl.parseLocalhostUrl(input);

    // Then
    expect(parsed).toEqual(expected);
  });

  it.each([
    ['another host', 'it is not a local server', 'https://example.com'],
    ['a .paseo name', 'it is not a local server', 'mytestapp.paseo'],
    ['nothing', 'no local server opens', ''],
    ['only spaces', 'no local server opens', '   '],
  ])('As a developer, I type %s and %s', (_typed, _outcome, input) => {
    // When
    const parsed = dotNsUrl.parseLocalhostUrl(input);

    // Then
    expect(parsed).toBeNull();
  });
});

describe('isDotDomain', () => {
  it('As a visitor, I type a .paseo name and it counts as a dot domain', () => {
    // When
    const isProduct = dotNsUrl.isDotDomain('mytestapp.paseo');

    // Then
    expect(isProduct).toBe(true);
  });

  it.each([
    ['a .dot.li domain', 'mytestapp.dot.li'],
    ['a domain of another TLD', 'example.com'],
    ['localhost', 'localhost'],
  ])('As a visitor, I type %s and it does not count as a dot domain', (_typed, input) => {
    // When
    const isProduct = dotNsUrl.isDotDomain(input);

    // Then
    expect(isProduct).toBe(false);
  });
});

describe('dotNS TLD per network', () => {
  it('As a user on Paseo, I open a .dot name and get a regular website', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), network: 'paseo-next-v2' }));

    // When
    const isProduct = dotNsUrl.isDotDomain('mytestapp.dot');

    // Then
    expect(isProduct).toBe(false);
  });

  it('As a user on Paseo, I open the gateway host paseo.li and it is not a product', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), network: 'paseo-next-v2' }));

    // When
    const parsed = dotNsUrl.parseDotNsDomain('mytestapp.paseo.li');

    // Then
    expect(parsed).toBeNull();
  });

  it('As a user on previewnet, I open a .testnet name and a .paseo name and only the .testnet name is a product', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), network: 'previewnet' }));

    // When
    const test = dotNsUrl.isDotDomain('mytestapp.testnet');
    const dot = dotNsUrl.isDotDomain('mytestapp.paseo');

    // Then
    expect(test).toBe(true);
    expect(dot).toBe(false);
  });
});

describe('isWebcontainerPreviewHost', () => {
  it.each([
    ['its credentialless preview host', 'abc--3000--def.local-credentialless.webcontainer-api.io'],
    ['its enterprise preview host', 'abc--3000--def.local-corp.webcontainer-api.io'],
    ['its preview host in capitals', 'ABC.WEBCONTAINER-API.IO'],
  ])('As a developer previewing in a webcontainer, I open %s and it is known as one', (_host, input) => {
    // When
    const isPreview = dotNsUrl.isWebcontainerPreviewHost(input);

    // Then
    expect(isPreview).toBe(true);
  });

  it.each(['mytestapp.paseo', 'localhost:3000', 'evil-webcontainer-api.io'])(
    'As a developer previewing in a webcontainer, I open %s and it is not taken for a preview host',
    input => {
      // When
      const isPreview = dotNsUrl.isWebcontainerPreviewHost(input);

      // Then
      expect(isPreview).toBe(false);
    },
  );
});
