// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { isValidDotLabel, validateDotLabel } from './dot-label.js';

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
});
