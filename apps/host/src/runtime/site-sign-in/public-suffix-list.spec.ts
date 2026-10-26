// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePublicSuffixList } from './public-suffix-list.js';

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

describe('parsePublicSuffixList', () => {
  it('As a site sign-in, I read a hostname under a single-label suffix and get its last two labels', () => {
    // Given a list with com
    const list = parsePublicSuffixList(LIST);

    // When the hostname is read
    const registrable = list.registrable('example.com');

    // Then the registrable domain is the suffix plus one label
    expect(registrable).toBe('example.com');
  });

  it('As a site sign-in, I read a deep hostname under a two-label suffix and get the suffix plus one label', () => {
    // Given a list with co.uk
    const list = parsePublicSuffixList(LIST);

    // When a deep hostname is read
    const registrable = list.registrable('a.b.example.co.uk');

    // Then the longest rule wins
    expect(registrable).toBe('example.co.uk');
  });

  it('As a site sign-in, I read two sites under a private suffix and get two registrable domains', () => {
    // Given a list with github.io in its private section
    const list = parsePublicSuffixList(LIST);

    // When both sites are read
    const alice = list.registrable('alice.github.io');
    const bob = list.registrable('bob.github.io');

    // Then each site is its own registrable domain
    expect(alice).toBe('alice.github.io');
    expect(bob).toBe('bob.github.io');
  });

  it('As a site sign-in, I read two sites under a numeric label suffix and get two registrable domains', () => {
    // Given a list with 0.bg
    const list = parsePublicSuffixList(LIST);

    // When both sites are read
    const x = list.registrable('x.0.bg');
    const y = list.registrable('y.0.bg');

    // Then each site is its own registrable domain
    expect(x).toBe('x.0.bg');
    expect(y).toBe('y.0.bg');
  });

  it('As a site sign-in, I read the hostname an exception rule names and get it as the registrable domain', () => {
    // Given a list with *.ck and !www.ck
    const list = parsePublicSuffixList(LIST);

    // When the excepted hostname is read
    const registrable = list.registrable('www.ck');

    // Then the exception wins over the wildcard
    expect(registrable).toBe('www.ck');
  });

  it('As a site sign-in, I read a hostname under a wildcard suffix and get the wildcard suffix plus one label', () => {
    // Given a list with *.ck
    const list = parsePublicSuffixList(LIST);

    // When a hostname three labels deep is read
    const registrable = list.registrable('a.b.ck');

    // Then the wildcard matched b.ck as the suffix
    expect(registrable).toBe('a.b.ck');
  });

  it('As a site sign-in, I read a hostname a wildcard rule makes a suffix and get none', () => {
    // Given a list with *.ck
    const list = parsePublicSuffixList(LIST);

    // When a hostname the wildcard covers whole is read
    const registrable = list.registrable('b.ck');

    // Then it is a public suffix itself
    expect(registrable).toBeNull();
  });

  it('As a site sign-in, I read a punycode hostname under an internationalised rule and get its registrable domain', () => {
    // Given a list with 个人.hk
    const list = parsePublicSuffixList(LIST);

    // When the hostname a URL gives for a site under it is read
    const registrable = list.registrable('a.shop.xn--ciqpn.hk');

    // Then the rule matched in its ASCII form
    expect(registrable).toBe('shop.xn--ciqpn.hk');
  });

  it('As a site sign-in, I read a hostname a URL did not convert to ASCII and get none', () => {
    // Given a list with 个人.hk
    const list = parsePublicSuffixList(LIST);

    // When a hostname with a Unicode label is read
    const registrable = list.registrable('a.个人.hk');

    // Then it fails closed
    expect(registrable).toBeNull();
  });

  it('As a site sign-in, I read localhost and addresses and get none', () => {
    // Given a list
    const list = parsePublicSuffixList(LIST);

    // When localhost, an IPv4 and a bracketed IPv6 address are read
    const read = ['localhost', '127.0.0.1', '[::1]'].map(hostname => list.registrable(hostname));

    // Then none has a registrable domain
    expect(read).toEqual([null, null, null]);
  });

  it('As a site sign-in, I read a hostname that is a public suffix and get none', () => {
    // Given a list with co.uk
    const list = parsePublicSuffixList(LIST);

    // When co.uk is read
    const registrable = list.registrable('co.uk');

    // Then it has no registrable domain
    expect(registrable).toBeNull();
  });

  it('As a site sign-in, I read hostnames with an empty label and get none', () => {
    // Given a list
    const list = parsePublicSuffixList(LIST);

    // When a trailing-dot hostname and one with an empty inner label are read
    const read = ['alice.github.io.', 'a..b.com', ''].map(hostname => list.registrable(hostname));

    // Then none has a registrable domain
    expect(read).toEqual([null, null, null]);
  });

  it('As a site sign-in, I read an uppercase hostname and get its lowercase registrable domain', () => {
    // Given a list with co.uk
    const list = parsePublicSuffixList(LIST);

    // When an uppercase hostname is read
    const registrable = list.registrable('WWW.Example.CO.UK');

    // Then the result is lowercase
    expect(registrable).toBe('example.co.uk');
  });

  it('As a site sign-in, I read a hostname under no rule and get the default rule plus one label', () => {
    // Given a list without the dev suffix
    const list = parsePublicSuffixList(LIST);

    // When a hostname under it is read
    const registrable = list.registrable('a.b.example.dev');

    // Then the default rule makes dev the suffix
    expect(registrable).toBe('example.dev');
  });

  it('As a site sign-in, I parse a rule whose ASCII form has another label count and the parse fails', () => {
    // Given a rule a URL reads as an IPv4 address
    const text = 'com\n0\n';

    // When the list is parsed
    const parse = () => parsePublicSuffixList(text);

    // Then it refuses the list
    expect(parse).toThrow('rule 0 reads as 0.0.0.0');
  });

  it('As a site sign-in, I parse the vendored list and read sites under its rules', () => {
    // Given the list the application ships
    const text = readFileSync(new URL('./public-suffix-list.dat', import.meta.url), 'utf8');

    // When it is parsed
    const list = parsePublicSuffixList(text);

    // Then its ICANN, numeric and private rules hold
    expect(list.registrable('www.example.co.uk')).toBe('example.co.uk');
    expect(list.registrable('x.0.bg')).toBe('x.0.bg');
    expect(list.registrable('alice.github.io')).toBe('alice.github.io');
    expect(list.registrable('bob.github.io')).toBe('bob.github.io');
  });
});
