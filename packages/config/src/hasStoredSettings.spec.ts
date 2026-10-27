// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { CACHE_KEY, DEFAULT_CACHE } from './cacheSettings.js';
import { hasStoredSettings } from './hasStoredSettings.js';

describe('hasStoredSettings', () => {
  it('As a first-time visitor, I hold no stored settings, and a returning one does', () => {
    // Given
    const firstVisit = createMemoryStorage();
    const returning = createMemoryStorage({ entries: { [CACHE_KEY]: JSON.stringify(DEFAULT_CACHE) } });

    // When
    const answers = [hasStoredSettings(firstVisit), hasStoredSettings(returning)];

    // Then
    expect(answers).toEqual([false, true]);
  });
});
