// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE, parseCacheSettings } from './cacheSettings.js';

describe('parseCacheSettings', () => {
  it('As a visitor, I bring a stored object with a switch missing and one malformed, and both are the default', () => {
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
