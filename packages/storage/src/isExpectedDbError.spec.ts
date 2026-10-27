// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { IdbOpenBlockedError } from '@dotli/shared';
import { isExpectedDbError } from './isExpectedDbError.js';

describe('isExpectedDbError', () => {
  it.each([
    new DOMException(
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      'InvalidStateError',
    ),
    new DOMException('An attempt was made to use an object that is not, or is no longer, usable', 'InvalidStateError'),
    new IdbOpenBlockedError('dotli'),
  ])('As a store whose database is closing or blocked, I take "%s" as expected and do not report it', error => {
    // When
    const expected = isExpectedDbError(error);

    // Then
    expect(expected).toBe(true);
  });

  it.each([
    new DOMException('quota', 'QuotaExceededError'),
    new Error('Failed to open dotli DB: VersionError'),
    new Error('Failed to open dotli DB: blocked by another tab'),
    'The database connection is closing',
  ])('As a store whose database fails, I take "%s" as a fault to report', error => {
    // When
    const expected = isExpectedDbError(error);

    // Then
    expect(expected).toBe(false);
  });
});
