// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hostFailure } from './failure.js';

describe('failure', () => {
  it('As a handler, I fail a call with an error as a handler that throws it would, and the caller reads its name', () => {
    // Given
    const thrown = new TypeError('bad label');
    const long = new Error('x'.repeat(600));

    // When
    const failures = [hostFailure(thrown), hostFailure(long)];

    // Then
    expect(failures).toEqual([
      { tag: 'HostFailure', value: { reason: 'TypeError: bad label' } },
      { tag: 'HostFailure', value: { reason: `Error: ${'x'.repeat(493)}` } },
    ]);
  });
});
