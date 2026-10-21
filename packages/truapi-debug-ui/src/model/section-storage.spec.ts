// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readStoredSection, writeStoredSection } from './section-storage.js';
import { memoryStorage } from '@dotli/shared/testing';
import { blockedStorage } from '../testing/blocked-storage.js';

describe('stored panel tab', () => {
  it('As a dotli developer, the tab I pick is the one the panel opens on next time', () => {
    // Given
    const storage = memoryStorage();

    // When
    writeStoredSection('diagnostics', storage);

    // Then
    expect(storage.getItem('truapi-debug:section')).toBe('diagnostics');
    expect(readStoredSection(storage)).toBe('diagnostics');
  });

  it('As a dotli developer with an unknown tab stored, the panel opens on the TrUAPI tab', () => {
    // Given
    const storage = memoryStorage({ 'truapi-debug:section': 'gone' });

    // When
    const section = readStoredSection(storage);

    // Then
    expect(section).toBe('truapi');
  });

  it('As a dotli developer whose storage is blocked, the panel opens on the TrUAPI tab and my pick is not kept', () => {
    // Given
    const storage = blockedStorage();

    // When
    writeStoredSection('wallet', storage);

    // Then
    expect(readStoredSection(storage)).toBe('truapi');
  });
});
