// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { fromCachedManifest, toCachedManifest } from './cachedManifest.js';
import { APP_V2, APP_V2_TEXT, EMPTY, NO_TEXT_RECORDS, ROOT, ROOT_TEXT } from './testing/manifestFixtures.js';

describe('cached manifests', () => {
  it('As a dotli user, I reload a cached app whose manifest this host does not read and it reads as unsupported again', () => {
    // When
    const cached = fromCachedManifest({ root: ROOT_TEXT, app: APP_V2_TEXT });

    // Then
    expect(cached.app.kind).toBe('unsupported-version');
  });

  it.each([
    ['a root manifest and no app manifest', { root: ROOT, app: EMPTY }, { root: ROOT_TEXT, app: null }],
    ['no text records and an app manifest', { root: NO_TEXT_RECORDS, app: APP_V2 }, { root: null, app: APP_V2_TEXT }],
  ])(
    'As a dotli user, I open a name with %s and its cache keeps the text of every manifest record that has one and null for the rest',
    (_case, manifests, expected) => {
      // When
      const cached = toCachedManifest(manifests);

      // Then
      expect(cached).toEqual(expected);
    },
  );
});
