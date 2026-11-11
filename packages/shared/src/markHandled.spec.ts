// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { markHandled } from './markHandled.js';

describe('markHandled', () => {
  it('As a caller that awaits early work later, I await it and see its rejection', async () => {
    // Given
    const failure = new Error('read failed');
    const rejected = Promise.reject(failure);

    // When
    const result = markHandled(rejected);

    // Then
    await expect(result).rejects.toBe(failure);
  });

  it('As a caller that never awaits early work, I leave a failed promise and nothing fails', () => {
    // Given
    const rejected = Promise.reject(new Error('read failed'));

    // When
    void markHandled(rejected);

    // Then
    // Nothing to assert: Vitest fails the run, not the case, on an unhandled rejection, which is the check.
    expect(true).toBe(true);
  });
});
