// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { readRedirectFields } from './readRedirectFields.js';

const SITE_PUBLIC_KEY = new Uint8Array(32).fill(5);
/** The site's key as its `pub` field carries it. */
const ENCODED_KEY = base64urlnopad.encode(SITE_PUBLIC_KEY);
const RETURN_TO = 'https://site.example/back?x=1';

describe('redirect fields', () => {
  it('As a site, I send return_to and pub and the window reads the return address and the key', () => {
    // Given params with both redirect fields
    const params = { round: 'r1', return_to: RETURN_TO, pub: ENCODED_KEY };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then both come back, the key as its bytes
    expect(fields).toEqual({ returnTo: RETURN_TO, sitePublicKey: SITE_PUBLIC_KEY });
  });

  it('As a site, I send neither field and the window reads no redirect', () => {
    // Given params with no redirect field
    const params = { round: 'r1' };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then there is no redirect
    expect(fields).toBe('none');
  });

  it.each<{ name: string; extra: Record<string, unknown> }>([
    { name: 'return_to alone', extra: { return_to: RETURN_TO } },
    { name: 'pub alone', extra: { pub: ENCODED_KEY } },
    { name: 'an http return_to off localhost', extra: { return_to: 'http://site.example/back', pub: ENCODED_KEY } },
    { name: 'a return_to with a fragment', extra: { return_to: 'https://site.example/back#x', pub: ENCODED_KEY } },
    {
      name: 'a return_to with an empty fragment',
      extra: { return_to: 'https://site.example/back#', pub: ENCODED_KEY },
    },
    { name: 'a relative return_to', extra: { return_to: '/back', pub: ENCODED_KEY } },
    { name: 'a return_to of another scheme', extra: { return_to: 'javascript:alert(1)', pub: ENCODED_KEY } },
    { name: 'a non-string return_to', extra: { return_to: 7, pub: ENCODED_KEY } },
    { name: 'a 31-byte pub', extra: { return_to: RETURN_TO, pub: base64urlnopad.encode(new Uint8Array(31)) } },
    { name: 'a 33-byte pub', extra: { return_to: RETURN_TO, pub: base64urlnopad.encode(new Uint8Array(33)) } },
    { name: 'a padded pub', extra: { return_to: RETURN_TO, pub: `${ENCODED_KEY}=` } },
    { name: 'a non-string pub', extra: { return_to: RETURN_TO, pub: 5 } },
  ])('As a site, I send $name and the window reads the redirect as invalid', ({ extra }) => {
    // Given params with that redirect field or fields
    const params = { round: 'r1', ...extra };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then they are invalid
    expect(fields).toBe('invalid');
  });

  it('As a local site, I send an http return_to on localhost and the window reads it', () => {
    // Given a return address on a localhost page over http
    const params = { round: 'r1', return_to: 'http://localhost:3000/back', pub: ENCODED_KEY };

    // When the redirect fields are read
    const fields = readRedirectFields(params);

    // Then the return address is accepted
    expect(fields).toEqual({ returnTo: 'http://localhost:3000/back', sitePublicKey: SITE_PUBLIC_KEY });
  });
});
