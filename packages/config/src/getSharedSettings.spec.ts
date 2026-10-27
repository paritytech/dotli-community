// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE } from './cacheSettings.js';
import { getSharedSettings } from './getSharedSettings.js';

describe('getSharedSettings', () => {
  it('As a visitor, I share my settings and only the backend and caches leave this origin', () => {
    // When
    const shared = getSharedSettings({ network: 'previewnet', backend: 'rpc-gateway', cache: DEFAULT_CACHE });

    // Then
    expect(shared).toEqual({ backend: 'rpc-gateway', cache: JSON.stringify(DEFAULT_CACHE) });
  });
});
