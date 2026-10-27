// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE, parseCacheSettings } from './cacheSettings.js';

describe('parseCacheSettings', () => {
  it('As a returning visitor, I bring stored cache switches and each applies', () => {
    // Given
    const stored = JSON.stringify({ skipCidCache: true, skipArchiveCache: true, skipWorkerCache: true });

    // When
    const cache = parseCacheSettings(stored);

    // Then
    expect(cache).toEqual({ skipCidCache: true, skipArchiveCache: true, skipWorkerCache: true });
  });

  it('As a visitor from an older build, I bring an object missing a switch and the missing one is the default', () => {
    // Given
    const stored = JSON.stringify({ skipCidCache: true, skipArchiveCache: 'yes' });

    // When
    const cache = parseCacheSettings(stored);

    // Then
    expect(cache).toEqual({ skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false });
  });

  it.each([null, '{"skipCidCache":', 'null', '[true]', '"skipCidCache"', '1'])(
    'As a visitor, I bring the stored value %j, which is no object, and every switch is the default',
    stored => {
      // When
      const cache = parseCacheSettings(stored);

      // Then
      expect(cache).toEqual(DEFAULT_CACHE);
    },
  );
});
