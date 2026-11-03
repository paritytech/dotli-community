// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSectionStorage } from './createSectionStorage.js';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createBlockedStorage } from '../testing/createBlockedStorage.js';

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

  it('As a dotli developer who goes back to the TrUAPI tab, I leave nothing stored and the panel opens on it on the next page load', () => {
    // Given
    const storage = createMemoryStorage({ entries: { 'truapi-debug:section': 'wallet' } });
    const sectionStorage = createSectionStorage({ storage });

    // When
    sectionStorage.set('truapi');
    const nextLoad = createSectionStorage({ storage }).get();

    // Then
    expect(storage.getItem('truapi-debug:section')).toBeNull();
    expect(nextLoad).toBe('truapi');
  });

  it('As a dotli developer with an unknown tab stored, I open the panel and it opens on the TrUAPI tab', () => {
    // Given
    const storage = createMemoryStorage({ entries: { 'truapi-debug:section': 'gone' } });

    // When
    const section = createSectionStorage({ storage }).get();

    // Then
    expect(section).toBe('truapi');
  });

  it('As a dotli developer whose storage is blocked, I pick a tab and it holds until the panel opens on the TrUAPI tab on the next page load', () => {
    // Given
    const storage = createBlockedStorage();
    const sectionStorage = createSectionStorage({ storage });

    // When
    sectionStorage.set('wallet');
    const nextLoad = createSectionStorage({ storage }).get();

    // Then
    expect(sectionStorage.get()).toBe('wallet');
    expect(nextLoad).toBe('truapi');
  });
});
