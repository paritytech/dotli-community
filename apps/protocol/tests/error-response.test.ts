// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { errorResponse } from '../src/error-response.js';

describe('errorResponse', () => {
  it('As a dotli maintainer, a failed request carries the head of the stack it was thrown from', () => {
    // Given
    const error = new TypeError('bad label');
    error.stack = `TypeError: bad label\n${'    at frame (protocol.js:1:1)\n'.repeat(200)}`;

    // When
    const response = errorResponse('r1', error);

    // Then
    expect(response).toEqual({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: 'r1',
      ok: false,
      error: 'bad label',
      errorName: 'TypeError',
      errorStack: error.stack.slice(0, 2000),
    });
  });

  it('As a dotli maintainer, a thrown non-Error still fails the request, with no class or stack to claim', () => {
    // When
    const response = errorResponse('r1', 'plain string');

    // Then
    expect(response).toEqual({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: 'r1',
      ok: false,
      error: 'plain string',
    });
  });
});
