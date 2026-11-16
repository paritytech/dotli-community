// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { parsePublicSuffixList } from './parsePublicSuffixList.js';

/** A few rules of each kind, in the list's own format. */
const LIST = `// This Source Code Form is subject to the terms of the Mozilla Public License.

// ===BEGIN ICANN DOMAINS===

// com
com

// uk
uk
co.uk

// bg
bg
0.bg

// ck
*.ck
!www.ck

// hk
hk
个人.hk

// ===END ICANN DOMAINS===
// ===BEGIN PRIVATE DOMAINS===

// GitHub
github.io

// ===END PRIVATE DOMAINS===
`;

describe('public suffix list', () => {
  it.each([
    { name: 'under a single-label suffix', hostnames: ['example.com'], registrable: ['example.com'] },
    {
      name: 'deep under a two-label suffix, where the longest rule wins,',
      hostnames: ['a.b.example.co.uk'],
      registrable: ['example.co.uk'],
    },
    {
      name: 'of two sites under a private suffix',
      hostnames: ['alice.github.io', 'bob.github.io'],
      registrable: ['alice.github.io', 'bob.github.io'],
    },
    {
      name: 'of two sites under a numeric label suffix',
      hostnames: ['x.0.bg', 'y.0.bg'],
      registrable: ['x.0.bg', 'y.0.bg'],
    },
    { name: 'an exception rule names, which wins over the wildcard,', hostnames: ['www.ck'], registrable: ['www.ck'] },
    { name: 'three labels deep under a wildcard suffix', hostnames: ['a.b.ck'], registrable: ['a.b.ck'] },
    { name: 'a wildcard rule makes a public suffix', hostnames: ['b.ck'], registrable: [null] },
    {
      name: 'in punycode under an internationalised rule, matched in its ASCII form,',
      hostnames: ['a.shop.xn--ciqpn.hk'],
      registrable: ['shop.xn--ciqpn.hk'],
    },
    { name: 'with a Unicode label a URL did not convert to ASCII', hostnames: ['a.个人.hk'], registrable: [null] },
    {
      name: 'of localhost, an IPv4 and a bracketed IPv6 address',
      hostnames: ['localhost', '127.0.0.1', '[::1]'],
      registrable: [null, null, null],
    },
    { name: 'that is a public suffix', hostnames: ['co.uk'], registrable: [null] },
    {
      name: 'with a trailing dot, an empty inner label or nothing at all',
      hostnames: ['alice.github.io.', 'a..b.com', ''],
      registrable: [null, null, null],
    },
    { name: 'in uppercase', hostnames: ['WWW.Example.CO.UK'], registrable: ['example.co.uk'] },
    {
      name: 'under no rule, where the default rule makes its last label the suffix,',
      hostnames: ['a.b.example.dev'],
      registrable: ['example.dev'],
    },
  ])(
    'As a user, I open a site whose hostname is $name and the window finds its registrable domain, or none',
    ({ hostnames, registrable }) => {
      // Given a list with a few rules of each kind
      const list = parsePublicSuffixList(LIST);

      // When each hostname is read
      const read = hostnames.map(hostname => list.registrable(hostname));

      // Then each has its registrable domain, or none
      expect(read).toEqual(registrable);
    },
  );

  it('As a dotli developer, I vendor a list with a rule whose ASCII form has another label count and the parse fails', () => {
    // Given a rule a URL reads as an IPv4 address
    const text = 'com\n0\n';

    // When the list is parsed
    const error = catchError(() => parsePublicSuffixList(text));

    // Then it refuses the list
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', expect.stringContaining('rule 0 reads as 0.0.0.0'));
  });

  it('As a dotli developer, I parse the vendored list and sites under its rules have their registrable domains', () => {
    // Given the list the application ships
    const text = readFileSync(new URL('./public-suffix-list.dat', import.meta.url), 'utf8');

    // When it is parsed and sites under its rules are read
    const list = parsePublicSuffixList(text);
    const read = ['www.example.co.uk', 'x.0.bg', 'alice.github.io', 'bob.github.io'].map(hostname =>
      list.registrable(hostname),
    );

    // Then its ICANN, numeric and private rules hold
    expect(read).toEqual(['example.co.uk', 'x.0.bg', 'alice.github.io', 'bob.github.io']);
  });
});
