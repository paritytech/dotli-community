// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from '@dotli/config';
import { fromHex } from '@dotli/shared';
import { encodeSs58, formatSiteAssertion, type SiteAssertionFields } from './site-assertion.js';

const FIELDS: SiteAssertionFields = {
  origin: 'https://my-site.com',
  address: '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5',
  statement: 'Optional statement from the site.',
  relayGenesis: NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].relay.genesis,
  nonce: '8f2c1a9e0b7d4e6f',
  issuedAt: Date.parse('2026-10-23T15:00:00.000Z'),
  username: { name: 'alice.dot', kind: 'full' },
  group: null,
};

describe('site assertion', () => {
  it('As a site, I receive the assertion text the sign-in library reads', () => {
    // Given the fields of a sign-in on Paseo with a statement
    const fields = FIELDS;

    // When the assertion is formatted
    const text = formatSiteAssertion(fields);

    // Then it is the library's text, line for line
    expect(text).toBe(
      [
        'my-site.com wants you to sign in with your Substrate account:',
        '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5',
        '',
        'Optional statement from the site.',
        '',
        'URI: https://my-site.com',
        'Version: 1',
        'Chain ID: polkadot:374057be67b355151f271ff70c3db983',
        'Nonce: 8f2c1a9e0b7d4e6f',
        'Issued At: 2026-10-23T15:00:00.000Z',
        'Expiration Time: 2026-10-23T15:05:00.000Z',
        'Resources:',
        '- urn:dotli:username:full:alice.dot',
      ].join('\n'),
    );
  });

  it('As a site of a group, I receive the assertion with its group line after the username line', () => {
    // Given the fields of a sign-in under a group token with a space
    const fields = { ...FIELDS, group: 'a b' };

    // When the assertion is formatted
    const text = formatSiteAssertion(fields);

    // Then the resources end with the username and then the group token, percent-encoded
    expect(text.split('\n').slice(-3)).toEqual([
      'Resources:',
      '- urn:dotli:username:full:alice.dot',
      '- urn:dotli:group:a%20b',
    ]);
  });

  it('As a site that sends no statement, I receive an assertion with no statement block', () => {
    // Given the fields without a statement
    const fields = { ...FIELDS, statement: null };

    // When the assertion is formatted
    const text = formatSiteAssertion(fields);

    // Then the address line is followed by one empty line and the URI
    expect(text.split('\n').slice(0, 4)).toEqual([
      'my-site.com wants you to sign in with your Substrate account:',
      '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5',
      '',
      'URI: https://my-site.com',
    ]);
  });

  it('As a site on a port, I see the port in the assertion header', () => {
    // Given an origin with a port
    const fields = { ...FIELDS, origin: 'http://localhost:5173' };

    // When the assertion is formatted
    const text = formatSiteAssertion(fields);

    // Then the header names the host with its port
    expect(text.split('\n')[0]).toBe('localhost:5173 wants you to sign in with your Substrate account:');
  });

  it('As a site, I receive a username with a space percent-encoded in its resource', () => {
    // Given a lite username with a space
    const fields = { ...FIELDS, username: { name: 'alice smith', kind: 'lite' as const } };

    // When the assertion is formatted
    const text = formatSiteAssertion(fields);

    // Then the resource line encodes the space
    expect(text.split('\n').at(-1)).toBe('- urn:dotli:username:lite:alice%20smith');
  });

  it('As a site, I read the SS58 address the library would encode for a key', () => {
    // Given the well-known Alice public key
    const publicKey = fromHex('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');

    // When it is encoded with the generic prefix
    const address = encodeSs58(publicKey, 42);

    // Then it is Alice's generic address
    expect(address).toBe('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
  });
});
