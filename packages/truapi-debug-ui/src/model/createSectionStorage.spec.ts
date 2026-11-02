// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSectionStorage } from './createSectionStorage.js';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createBlockedStorage } from '../testing/createBlockedStorage.js';

describe('createSectionStorage()', () => {
  it('As a dotli developer, I pick a tab and the panel opens on it next time', () => {
    // Given
    const storage = createMemoryStorage();
    const sectionStorage = createSectionStorage({ storage });

    // When
    sectionStorage.write('diagnostics');
    const section = sectionStorage.read();

    // Then
    expect(storage.getItem('truapi-debug:section')).toBe('diagnostics');
    expect(section).toBe('diagnostics');
  });

  it('As a dotli developer with an unknown tab stored, I open the panel and it opens on the TrUAPI tab', () => {
    // Given
    const sectionStorage = createSectionStorage({
      storage: createMemoryStorage({ entries: { 'truapi-debug:section': 'gone' } }),
    });

    // When
    const section = sectionStorage.read();

    // Then
    expect(section).toBe('truapi');
  });

  it('As a dotli developer whose storage is blocked, I pick a tab and the panel opens on the TrUAPI tab with my pick not kept', () => {
    // Given
    const sectionStorage = createSectionStorage({ storage: createBlockedStorage() });

    // When
    sectionStorage.write('wallet');
    const section = sectionStorage.read();

    // Then
    expect(section).toBe('truapi');
  });
});
