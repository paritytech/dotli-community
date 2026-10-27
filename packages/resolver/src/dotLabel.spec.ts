// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { getSandboxLabel, isValidDotLabel, isValidDotName, validateDotLabel, validateDotName } from './dotLabel.js';

describe('validateDotLabel', () => {
  it.each([
    ['with hyphens inside it', 'my-app'],
    ['that only starts with the letters x and n', 'xnapp'],
    ['of two characters', '01'],
  ])('As a visitor, I open a name %s and it is accepted', (_shape, label) => {
    // When
    const result = validateDotLabel(label);

    // Then the label is accepted
    expect(result).toEqual({ ok: true });
  });

  it.each([
    ['a punycode name', 'its letters can look like another name', 'xn--pypal-4ve', 'punycode'],
    ['a name that starts with sn--', "it would share a subname's sandbox", 'sn--abc', 'reserved'],
    ['a one-letter name', 'no name under .dot is that short', 'p', 'too-short'],
    ['another one-letter name', 'no name under .dot is that short', 's', 'too-short'],
  ])('As a visitor, I try %s and it is refused, since %s', (_name, _why, label, reason) => {
    // When
    const result = validateDotLabel(label);
    const valid = isValidDotLabel(label);

    // Then the label is refused for its reason
    expect(result).toEqual({ ok: false, reason });
    expect(valid).toBe(false);
  });
});

describe('validateDotName', () => {
  it('As a visitor, I open a subname and each of its labels is checked', () => {
    // When
    const subname = isValidDotName('pr16.back-me-up');
    const label = isValidDotName('doom');
    const leadingHyphen = validateDotName('pr16.-back');
    const emptyLabel = validateDotName('pr16..back');
    const punycode = validateDotName('pr16.xn--pypal-4ve');

    // Then a subname of valid labels is accepted and one with an invalid label is refused
    expect(subname).toBe(true);
    expect(label).toBe(true);
    expect(leadingHyphen).toEqual({ ok: false, reason: 'leading-hyphen' });
    expect(emptyLabel).toEqual({ ok: false, reason: 'empty' });
    expect(punycode).toEqual({ ok: false, reason: 'punycode' });
  });

  it('As a visitor, I open a subname and only its registered label must be two characters or more', () => {
    // When
    const shortSubnameLabel = validateDotName('a.my-app');
    const shortUnderSubname = validateDotName('pr16.a');
    const shortAlone = validateDotName('p');
    const deviceName = validateDotName('michael.01');
    const badSubnameLabel = validateDotName('-a.my-app');

    // Then a one-letter subname label is accepted, a one-letter registered label is refused whether it stands
    // alone or under a subname, a device name under its two-digit node is accepted, and a subname label still gets
    // the shape rules
    expect(shortSubnameLabel).toEqual({ ok: true });
    expect(shortUnderSubname).toEqual({ ok: false, reason: 'too-short' });
    expect(shortAlone).toEqual({ ok: false, reason: 'too-short' });
    expect(deviceName).toEqual({ ok: true });
    expect(badSubnameLabel).toEqual({ ok: false, reason: 'leading-hyphen' });
  });

  it('As a visitor, I try a name longer than a hostname can carry and it is refused', () => {
    // Given a name of valid labels over 253 characters
    const name = Array.from({ length: 5 }, () => 'a'.repeat(63)).join('.');

    // When
    const result = validateDotName(name);

    // Then the name is refused as too long
    expect(result).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('getSandboxLabel', () => {
  it('As a visitor, I open a product by one label and its sandbox keeps the origin it had', () => {
    // When
    const label = getSandboxLabel('back-me-up');

    // Then the label names its sandbox itself
    expect(label).toBe('back-me-up');
  });

  it('As a visitor, I open a subname and its sandbox gets one label of its own that no registered label can take', () => {
    // When
    const label = getSandboxLabel('pr16.back-me-up');
    const again = getSandboxLabel('pr16.back-me-up');
    const other = getSandboxLabel('pr17.back-me-up');
    const registrable = isValidDotLabel(label);

    // Then the label is one DNS label, stable, distinct per name and refused as a registered label
    expect(label).toMatch(/^sn--[0-9a-f]{59}$/);
    expect(again).toBe(label);
    expect(other).not.toBe(label);
    expect(registrable).toBe(false);
  });
});
