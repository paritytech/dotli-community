// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { compareCachedCid } from './compareCachedCid.js';

describe('cache revalidation', () => {
  it.each([
    ['an app that was not redeployed and it keeps its cached copy', 'bafy-served', { kind: 'keep' }],
    [
      'a redeployed app and it is told apart by its contenthash alone',
      'bafy-fresh',
      { kind: 'newer', cid: 'bafy-fresh' },
    ],
    [
      'an app whose name no longer resolves and it is dropped from the cache',
      null,
      { kind: 'evict', reason: 'cleared' },
    ],
  ])('As a dotli user, I come back to %s', (_case, freshCid, expected) => {
    // When
    const comparison = compareCachedCid('bafy-served', freshCid);

    // Then
    expect(comparison).toEqual(expected);
  });
});
