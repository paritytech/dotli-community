// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readStoredDock, writeStoredDock } from './dock-storage.js';
import { memoryStorage } from '@dotli/shared/testing';
import { blockedStorage } from '../testing/blocked-storage.js';

describe('stored panel dock', () => {
  it('As a dotli developer, a stored right dock is applied on the next mount', () => {
    // Given
    const storage = memoryStorage({ 'truapi-debug:dock': 'right' });

    // When
    const dock = readStoredDock(storage);

    // Then
    expect(dock).toBe('right');
  });

  it('As a dotli developer, the dock I pick is stored for the next mount', () => {
    // Given
    const storage = memoryStorage();

    // When
    writeStoredDock('bottom', storage);

    // Then
    expect(storage.getItem('truapi-debug:dock')).toBe('bottom');
    expect(readStoredDock(storage)).toBe('bottom');
  });

  it('As a dotli developer whose storage is blocked, the panel docks at the bottom', () => {
    // Given
    const storage = blockedStorage();

    // When
    writeStoredDock('right', storage);

    // Then
    expect(readStoredDock(storage)).toBe('bottom');
  });
});
