// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSectionStorage } from './createSectionStorage.js';
import { createMemoryStorage } from '@dotli/shared/testing';

describe('createSectionStorage()', () => {
  it('As a dotli developer, I pick a tab and the panel opens on it on the next page load', () => {
    // Given
    const storage = createMemoryStorage();
    const sectionStorage = createSectionStorage({ storage });

    // When
    sectionStorage.set('diagnostics');
    const nextLoad = createSectionStorage({ storage }).get();

    // Then
    expect(storage.getItem('truapi-debug:section')).toBe('diagnostics');
    expect(nextLoad).toBe('diagnostics');
  });

  it('As a dotli developer with an unknown tab stored, I open the panel and it opens on the TrUAPI tab', () => {
    // Given
    const storage = createMemoryStorage({ entries: { 'truapi-debug:section': 'gone' } });

    // When
    const section = createSectionStorage({ storage }).get();

    // Then
    expect(section).toBe('truapi');
  });
});
