// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { VALID_ROOT } from './testing/constants.js';
import { parseRootManifest, validateRootManifest } from './validateRootManifest.js';

describe('validateRootManifest', () => {
  it('As the host validating a root manifest, I accept a well-formed one', () => {
    // When
    const result = validateRootManifest(VALID_ROOT);

    // Then
    expect(result.ok).toBe(true);
  });

  it('As the host validating a root manifest, I report a $v other than 1 as an unsupported version without checking its fields', () => {
    // When
    const result = validateRootManifest({ $v: 2, title: 'not a v1 shape' });

    // Then
    expect(result).toEqual({
      ok: false,
      unsupportedVersion: 2,
      errors: ['root manifest $v 2 is not supported (expected 1)'],
    });
  });

  it('As the host validating a root manifest, I report a missing $v as an unsupported version', () => {
    // Given
    const { $v: _omitted, ...withoutVersion } = VALID_ROOT;

    // When
    const result = validateRootManifest(withoutVersion);

    // Then
    expect(result).toMatchObject({ ok: false, unsupportedVersion: undefined });
  });

  it('As the host validating a root manifest, I refuse an empty display name', () => {
    // When
    const result = validateRootManifest({ ...VALID_ROOT, displayName: '' });

    // Then
    expect(result.ok).toBe(false);
  });

  it('As the host validating a root manifest, I accept an unrecognised icon format, which only costs the icon', () => {
    // When
    const result = validateRootManifest({ ...VALID_ROOT, icon: { cid: 'bafy', format: 'gif' } });

    // Then
    expect(result.ok).toBe(true);
  });

  it('As the host validating a root manifest, I refuse an icon format that is not a string', () => {
    // When
    const result = validateRootManifest({ ...VALID_ROOT, icon: { cid: 'bafy', format: 7 } });

    // Then
    expect(result.ok).toBe(false);
  });

  it('As the host validating a root manifest, I accept trusted products, unrecognised grant values included', () => {
    // When
    const result = validateRootManifest({ ...VALID_ROOT, trustedProducts: { wallet: ['all', 'teleport'] } });

    // Then
    expect(result.ok).toBe(true);
  });

  it.each([
    ['an array', ['wallet']],
    ['a grant list that is not an array', { wallet: 'all' }],
    ['a grant that is not a string', { wallet: [1] }],
  ])('As the host validating a root manifest, I refuse trusted products given as %s', (_case, trustedProducts) => {
    // When
    const result = validateRootManifest({ ...VALID_ROOT, trustedProducts });

    // Then
    expect(result.ok).toBe(false);
  });

  it.each([null, 'string', []])(
    'As the host validating a root manifest, I refuse the input %j, which is not an object',
    input => {
      // When
      const result = validateRootManifest(input);

      // Then
      expect(result.ok).toBe(false);
    },
  );
});

describe('parseRootManifest', () => {
  it('As the host validating a root manifest, I refuse record text that is not JSON', () => {
    // When
    const result = parseRootManifest('{ not valid');

    // Then
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/not valid JSON/)] });
  });
});
