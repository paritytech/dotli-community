// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDockStorage } from './createDockStorage.js';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createBlockedStorage } from '../testing/createBlockedStorage.js';

describe('createDockStorage()', () => {
  it('As a dotli developer with a right dock stored, I mount the panel and it docks right', () => {
    // Given
    const storage = createMemoryStorage({ entries: { 'truapi-debug:dock': 'right' } });

    // When
    const dock = createDockStorage({ storage }).get();

    // Then
    expect(dock).toBe('right');
  });

  it('As a developer with a stored dock that no longer parses, I see the panel at the bottom', () => {
    // Given
    const storage = createMemoryStorage({ entries: { 'truapi-debug:dock': 'left' } });

    // When
    const dock = createDockStorage({ storage }).get();

    // Then
    expect(dock).toBe('bottom');
  });

  it('As a dotli developer, I pick the right dock and it is stored for the next page load', () => {
    // Given
    const storage = createMemoryStorage();
    const dockStorage = createDockStorage({ storage });

    // When
    dockStorage.set('right');
    const nextLoad = createDockStorage({ storage }).get();

    // Then
    expect(storage.getItem('truapi-debug:dock')).toBe('right');
    expect(nextLoad).toBe('right');
  });

  it('As a dotli developer who docks back to the bottom, I leave nothing stored and the next page load docks at the bottom', () => {
    // Given
    const storage = createMemoryStorage({ entries: { 'truapi-debug:dock': 'right' } });
    const dockStorage = createDockStorage({ storage });

    // When
    dockStorage.set('bottom');
    const nextLoad = createDockStorage({ storage }).get();

    // Then
    expect(storage.getItem('truapi-debug:dock')).toBeNull();
    expect(nextLoad).toBe('bottom');
  });

  it('As a dotli developer whose storage is blocked, I pick the right dock and it holds until the next page load docks at the bottom', () => {
    // Given
    const storage = createBlockedStorage();
    const dockStorage = createDockStorage({ storage });

    // When
    dockStorage.set('right');
    const nextLoad = createDockStorage({ storage }).get();

    // Then
    expect(dockStorage.get()).toBe('right');
    expect(nextLoad).toBe('bottom');
  });
});
