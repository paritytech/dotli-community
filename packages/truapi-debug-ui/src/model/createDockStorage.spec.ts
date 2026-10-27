// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDockStorage } from './createDockStorage.js';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createBlockedStorage } from '../testing/createBlockedStorage.js';

describe('createDockStorage()', () => {
  it('As a dotli developer with a right dock stored, I mount the panel and it docks right', () => {
    // Given
    const dockStorage = createDockStorage({
      storage: createMemoryStorage({ entries: { 'truapi-debug:dock': 'right' } }),
    });

    // When
    const dock = dockStorage.read();

    // Then
    expect(dock).toBe('right');
  });

  it('As a dotli developer, I pick a dock and it is stored for the next mount', () => {
    // Given
    const storage = createMemoryStorage();
    const dockStorage = createDockStorage({ storage });

    // When
    dockStorage.write('bottom');
    const dock = dockStorage.read();

    // Then
    expect(storage.getItem('truapi-debug:dock')).toBe('bottom');
    expect(dock).toBe('bottom');
  });

  it('As a dotli developer whose storage is blocked, I pick the right dock and the panel docks at the bottom', () => {
    // Given
    const dockStorage = createDockStorage({ storage: createBlockedStorage() });

    // When
    dockStorage.write('right');
    const dock = dockStorage.read();

    // Then
    expect(dock).toBe('bottom');
  });
});
