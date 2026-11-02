// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { BACKEND_KEY } from './backend.js';
import { CACHE_KEY, DEFAULT_CACHE } from './cacheSettings.js';
import { NETWORK_KEY } from './networkNames.js';
import { resolveSettings } from './resolveSettings.js';
import { writeLocalSettings } from './writeLocalSettings.js';

describe('writeLocalSettings', () => {
  it('As a visitor from an old build, I store my settings and they land under the current keys with the old key gone', () => {
    // Given
    const local = createMemoryStorage({ entries: { 'dotli:mode': 'gateway' } });
    const { settings } = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // When
    writeLocalSettings(settings, local);

    // Then
    expect(local.getItem(NETWORK_KEY)).toBe('paseo-next-v2');
    expect(local.getItem(BACKEND_KEY)).toBe('rpc-gateway');
    expect(local.getItem(CACHE_KEY)).toBe(JSON.stringify(DEFAULT_CACHE));
    expect(local.getItem('dotli:mode')).toBeNull();
    expect(local.length).toBe(3);
  });
});
