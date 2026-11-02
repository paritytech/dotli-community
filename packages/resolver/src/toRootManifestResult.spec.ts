// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { VALID_ROOT } from './testing/constants.js';
import { toRootManifestResult } from './toRootManifestResult.js';

const ROOT = JSON.stringify(VALID_ROOT);

describe('toRootManifestResult', () => {
  it.each([null, ''])('As the host reading a root manifest record, I read %j as no manifest', raw => {
    // When
    const result = toRootManifestResult(raw);

    // Then
    expect(result).toEqual({ kind: 'empty' });
  });

  it('As the host reading a root manifest record, I keep its text next to the valid manifest', () => {
    // When
    const result = toRootManifestResult(ROOT);

    // Then
    expect(result).toMatchObject({ kind: 'ok', value: { displayName: 'HackM3' }, raw: ROOT });
  });

  it('As the host reading a root manifest record, I report an unknown $v as an unsupported version', () => {
    // Given
    const raw = JSON.stringify({ $v: 3 });

    // When
    const result = toRootManifestResult(raw);

    // Then
    expect(result).toEqual({ kind: 'unsupported-version', version: '3', raw });
  });

  it('As the host reading a root manifest record, I report text that is not JSON as invalid', () => {
    // When
    const result = toRootManifestResult('{ nope');

    // Then
    expect(result).toMatchObject({ kind: 'invalid', raw: '{ nope' });
  });
});
