// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, it, expect, afterEach } from 'vitest';
import { NetworkName, setNetworkOverride, configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';
import { dotNsUrl } from './dotns-url.js';

// Settings come from a memory store, not Node's localStorage, and the previous store is put back after each test.
beforeEach(() => configureModeStorage(memoryModeStorage()));

describe('parseDotNsDomain', () => {
  it('As a visitor, I type a bare .paseo name and it opens as that product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('mytestapp.paseo')).toEqual({
      identifier: 'mytestapp.paseo',
      pathname: '',
    });
  });

  it('As a visitor, I type a .dot.li domain and it is a regular website, not a product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('mytestapp.dot.li')).toBeNull();
  });

  it('As a visitor, I type a .paseo name after https:// and it opens as that product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('https://mytestapp.paseo')).toEqual({
      identifier: 'mytestapp.paseo',
      pathname: '',
    });
  });

  it('As a visitor, I type a .paseo name after http:// and it opens as that product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('http://mytestapp.paseo')).toEqual({
      identifier: 'mytestapp.paseo',
      pathname: '',
    });
  });

  it('As a visitor, I type a .paseo name with a path and it opens at that path', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('mytestapp.paseo/some/path')).toEqual({
      identifier: 'mytestapp.paseo',
      pathname: 'some/path',
    });
  });

  it('As a visitor, I type a .dot.li domain with a path and it is a regular website', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('mytestapp.dot.li/some/path')).toBeNull();
  });

  it('As a visitor, I type a .paseo name with only a query and it opens with that query', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('pr508.faucet.paseo?embed=1')).toEqual({
      identifier: 'pr508.faucet.paseo',
      pathname: '?embed=1',
    });
  });

  it('As a visitor, I type a .paseo name after https:// with only a query and it opens with that query', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('https://pr508.faucet.paseo?embed=1')).toEqual({
      identifier: 'pr508.faucet.paseo',
      pathname: '?embed=1',
    });
  });

  it('As a visitor, I type a .paseo name with only a hash and it opens with that hash', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('pr508.faucet.paseo#section=main')).toEqual({
      identifier: 'pr508.faucet.paseo',
      pathname: '#section=main',
    });
  });

  it('As a visitor, I type a .paseo name with a path, query and hash and it opens with all three', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('pr508.faucet.paseo/nested/path?embed=1#frame=compact')).toEqual({
      identifier: 'pr508.faucet.paseo',
      pathname: 'nested/path?embed=1#frame=compact',
    });
  });

  it('As a visitor, I type a polkadot:// URL on a .paseo host and it opens as that product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('polkadot://currenthost.paseo/mytestapp.paseo')).toEqual({
      identifier: 'currenthost.paseo',
      pathname: 'mytestapp.paseo',
    });
  });

  it('As a visitor, I type a polkadot:// URL on a .dot.li host and it is not a product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('polkadot://currenthost.dot.li/mytestapp.paseo')).toBeNull();
  });

  it('As a visitor, I type a polkadot:// URL on a .paseo host with a path and it opens at that path', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('polkadot://currenthost.paseo/mytestapp.paseo/settings')).toEqual({
      identifier: 'currenthost.paseo',
      pathname: 'mytestapp.paseo/settings',
    });
  });

  it('As a visitor, I type a polkadot:// URL on a .paseo host with a query and hash and it opens with both', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('polkadot://currenthost.paseo/mytestapp.paseo?embed=1#frame=compact')).toEqual({
      identifier: 'currenthost.paseo',
      pathname: 'mytestapp.paseo?embed=1#frame=compact',
    });
  });

  it('As a visitor, I type a polkadot:// URL on a .paseo host with a plain path and it opens at that path', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('polkadot://currenthost.paseo/settings')).toEqual({
      identifier: 'currenthost.paseo',
      pathname: 'settings',
    });
  });

  it('As a visitor, I type a polkadot:// URL on another host and it is not a product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('polkadot://example.com/settings')).toBeNull();
  });

  it('As a visitor, I type a .paseo subname with a path and it opens as that product at that path', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('sub.acme.paseo/path')).toEqual({
      identifier: 'sub.acme.paseo',
      pathname: 'path',
    });
  });

  it('As a visitor, I type a .dot.li URL with a protocol and it is a regular website', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('https://mytestapp.dot.li/path?q=1')).toBeNull();
  });

  it('As a visitor, I type a .paseo name with spaces around it and the spaces are ignored', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('  mytestapp.paseo/path  ')).toEqual({
      identifier: 'mytestapp.paseo',
      pathname: 'path',
    });
  });

  it('As a visitor, I type a localhost address and it is not a .paseo product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('localhost:3000/path')).toBeNull();
  });

  it('As a visitor, I type an http://localhost URL and it is not a .paseo product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('http://localhost:3000/path')).toBeNull();
  });

  it('As a visitor, I type a domain of another TLD and it is not a product', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('example.com')).toBeNull();
  });

  it('As a visitor, I type nothing and no product opens', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('')).toBeNull();
  });

  it('As a visitor, I type only spaces and no product opens', () => {
    // When / Then
    expect(dotNsUrl.parseDotNsDomain('   ')).toBeNull();
  });
});

describe('parseLocalhostUrl', () => {
  it('As a developer, I type localhost with a port and it opens that local server', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('localhost:3000')).toEqual({
      host: 'localhost:3000',
      pathname: '',
    });
  });

  it('As a developer, I type localhost with a port and path and it opens that path', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('localhost:3000/some/path')).toEqual({
      host: 'localhost:3000',
      pathname: 'some/path',
    });
  });

  it('As a developer, I type http://localhost with a port and it opens that local server', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('http://localhost:5000')).toEqual({
      host: 'localhost:5000',
      pathname: '',
    });
  });

  it('As a developer, I type http://localhost with a port and path and it opens that path', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('http://localhost:5000/path')).toEqual({
      host: 'localhost:5000',
      pathname: 'path',
    });
  });

  it('As a developer, I type localhost with a query and hash and it opens with both', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('localhost:3000/path?q=1#h')).toEqual({
      host: 'localhost:3000',
      pathname: 'path?q=1#h',
    });
  });

  it('As a developer, I type bare localhost and it opens that local server', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('localhost')).toEqual({
      host: 'localhost',
      pathname: '',
    });
  });

  it('As a developer, I type another host and it is not a local server', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('https://example.com')).toBeNull();
  });

  it('As a developer, I type localhost with a path and no port and it opens that path', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('localhost/path')).toEqual({
      host: 'localhost',
      pathname: 'path',
    });
  });

  it('As a developer, I type http://localhost with a path and no port and it opens that path', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('http://localhost/path')).toEqual({
      host: 'localhost',
      pathname: 'path',
    });
  });

  it('As a developer, I type a .paseo name and it is not a local server', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('mytestapp.paseo')).toBeNull();
  });

  it('As a developer, I type nothing and no local server opens', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('')).toBeNull();
  });

  it('As a developer, I type only spaces and no local server opens', () => {
    // When / Then
    expect(dotNsUrl.parseLocalhostUrl('   ')).toBeNull();
  });
});

describe('isDotDomain', () => {
  it('As a visitor, I type a .paseo name and it counts as a dot domain', () => {
    // When / Then
    expect(dotNsUrl.isDotDomain('mytestapp.paseo')).toBe(true);
  });

  it('As a visitor, I type a .dot.li domain and it does not count as a dot domain', () => {
    // When / Then
    expect(dotNsUrl.isDotDomain('mytestapp.dot.li')).toBe(false);
  });

  it('As a visitor, I type a domain of another TLD and it does not count as a dot domain', () => {
    // When / Then
    expect(dotNsUrl.isDotDomain('example.com')).toBe(false);
  });

  it('As a visitor, I type localhost and it does not count as a dot domain', () => {
    // When / Then
    expect(dotNsUrl.isDotDomain('localhost')).toBe(false);
  });
});

describe('dotNS TLD per network', () => {
  afterEach(() => {
    setNetworkOverride(NetworkName.PASEO);
  });

  it('As a user on Paseo, I open a .paseo name and reach the product', () => {
    // Given
    setNetworkOverride(NetworkName.PASEO);

    // When
    const parsed = dotNsUrl.parseDotNsDomain('mytestapp.paseo/some/path');

    // Then
    expect(parsed).toEqual({
      identifier: 'mytestapp.paseo',
      pathname: 'some/path',
    });
  });

  it('As a user on Paseo, I open a .dot name and get a regular website', () => {
    // Given
    setNetworkOverride(NetworkName.PASEO);

    // When
    const isProduct = dotNsUrl.isDotDomain('mytestapp.dot');

    // Then
    expect(isProduct).toBe(false);
  });

  it('As a user on Paseo, the gateway host paseo.li is not a product', () => {
    // Given
    setNetworkOverride(NetworkName.PASEO);

    // When
    const parsed = dotNsUrl.parseDotNsDomain('mytestapp.paseo.li');

    // Then
    expect(parsed).toBeNull();
  });

  it('As a user on previewnet, a .testnet name is a product and a .paseo name is not', () => {
    // Given
    setNetworkOverride(NetworkName.PREVIEWNET);

    // When
    const test = dotNsUrl.isDotDomain('mytestapp.testnet');
    const dot = dotNsUrl.isDotDomain('mytestapp.paseo');

    // Then
    expect(test).toBe(true);
    expect(dot).toBe(false);
  });
});

describe('isWebcontainerPreviewHost', () => {
  it('As a developer previewing in a webcontainer, I open its credentialless preview host and it is known as one', () => {
    // When / Then
    expect(dotNsUrl.isWebcontainerPreviewHost('abc--3000--def.local-credentialless.webcontainer-api.io')).toBe(true);
  });

  it('As a developer previewing in a webcontainer, I open its enterprise preview host and it is known as one', () => {
    // When / Then
    expect(dotNsUrl.isWebcontainerPreviewHost('abc--3000--def.local-corp.webcontainer-api.io')).toBe(true);
  });

  it('As a developer previewing in a webcontainer, I open its preview host in capitals and it is known as one', () => {
    // When / Then
    expect(dotNsUrl.isWebcontainerPreviewHost('ABC.WEBCONTAINER-API.IO')).toBe(true);
  });

  it('As a developer previewing in a webcontainer, I open other hosts and they are not taken for one', () => {
    // When / Then
    expect(dotNsUrl.isWebcontainerPreviewHost('mytestapp.paseo')).toBe(false);
    expect(dotNsUrl.isWebcontainerPreviewHost('localhost:3000')).toBe(false);
    expect(dotNsUrl.isWebcontainerPreviewHost('evil-webcontainer-api.io')).toBe(false);
  });
});
