// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { isValidDotLabel, isValidDotName, sandboxLabel, validateDotLabel, validateDotName } from './dot-label.js';

describe('validateDotLabel', () => {
  it('As a visitor, I try a punycode name and it is refused, since its letters can look like another name', () => {
    // When / Then the label is refused as punycode
    expect(validateDotLabel('xn--pypal-4ve')).toEqual({ ok: false, reason: 'punycode' });
    expect(isValidDotLabel('xn--pypal-4ve')).toBe(false);
  });

  it('As a visitor, I open a name with hyphens inside it and it is accepted', () => {
    // When / Then the label is accepted
    expect(validateDotLabel('my-app')).toEqual({ ok: true });
  });

  it('As a visitor, I open a name that only starts with the letters x and n and it is accepted', () => {
    // When / Then the label is accepted
    expect(validateDotLabel('xnapp')).toEqual({ ok: true });
  });

  it("As a visitor, I try a name that starts with sn-- and it is refused, since it would share a subname's sandbox", () => {
    // When / Then the label is refused as reserved
    expect(validateDotLabel('sn--abc')).toEqual({ ok: false, reason: 'reserved' });
  });

  it('As a visitor, I try a one-letter name and it is refused, since no name under .dot is that short', () => {
    // When / Then a one-letter label is refused as too short and a two-letter label is accepted
    expect(validateDotLabel('p')).toEqual({ ok: false, reason: 'too-short' });
    expect(isValidDotLabel('s')).toBe(false);
    expect(validateDotLabel('01')).toEqual({ ok: true });
  });
});

describe('validateDotName', () => {
  it('As a visitor, I open a subname and each of its labels is checked', () => {
    // When / Then a subname of valid labels is accepted and one with an invalid label is refused
    expect(isValidDotName('pr16.back-me-up')).toBe(true);
    expect(isValidDotName('doom')).toBe(true);
    expect(validateDotName('pr16.-back')).toEqual({ ok: false, reason: 'leading-hyphen' });
    expect(validateDotName('pr16..back')).toEqual({ ok: false, reason: 'empty' });
    expect(validateDotName('pr16.xn--pypal-4ve')).toEqual({ ok: false, reason: 'punycode' });
  });

  it('As a visitor, I open a subname and only its registered label must be two characters or more', () => {
    // When / Then a one-letter subname label is accepted, a one-letter registered label is refused whether it stands
    // alone or under a subname, a device name under its two-digit node is accepted, and a subname label still gets
    // the shape rules
    expect(validateDotName('a.my-app')).toEqual({ ok: true });
    expect(validateDotName('pr16.a')).toEqual({ ok: false, reason: 'too-short' });
    expect(validateDotName('p')).toEqual({ ok: false, reason: 'too-short' });
    expect(validateDotName('michael.01')).toEqual({ ok: true });
    expect(validateDotName('-a.my-app')).toEqual({ ok: false, reason: 'leading-hyphen' });
  });

  it('As a visitor, I try a name longer than a hostname can carry and it is refused', () => {
    // Given a name of valid labels over 253 characters
    const name = Array.from({ length: 5 }, () => 'a'.repeat(63)).join('.');

    // When / Then the name is refused as too long
    expect(validateDotName(name)).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('sandboxLabel', () => {
  it('As a visitor, I open a product by one label and its sandbox keeps the origin it had', () => {
    // When / Then the label names its sandbox itself
    expect(sandboxLabel('back-me-up')).toBe('back-me-up');
  });

  it('As a visitor, I open a subname and its sandbox gets one label of its own that no registered label can take', () => {
    // When
    const label = sandboxLabel('pr16.back-me-up');

    // Then the label is one DNS label, stable, distinct per name and refused as a registered label
    expect(label).toMatch(/^sn--[0-9a-f]{59}$/);
    expect(sandboxLabel('pr16.back-me-up')).toBe(label);
    expect(sandboxLabel('pr17.back-me-up')).not.toBe(label);
    expect(isValidDotLabel(label)).toBe(false);
  });
});
