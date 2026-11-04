// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { fromCachedManifest, toCachedManifest } from './cachedManifest.js';
import { parseH160Address } from './h160Address.js';
import { APP_V2, APP_V2_TEXT, EMPTY, NO_TEXT_RECORDS, ROOT, ROOT_TEXT } from './testing/manifestFixtures.js';

const OWNER = parseH160Address(`0x${'ab'.repeat(20)}`);

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

  it.each([
    ['an owner', OWNER],
    ['no owner', null],
  ])('As a dotli user, I come back to a name with %s and the cache gives back the owner it kept', (_case, owner) => {
    // Given a product whose owner was read with its manifests
    const manifests = { root: ROOT, app: EMPTY, owner };

    // When its cached copy is read back
    const cached = fromCachedManifest(toCachedManifest(manifests));

    // Then the owner it kept comes back
    expect(cached.owner).toBe(owner);
  });

  it('As a dotli user, I open a name whose owner could not be read and its cache keeps no owner', () => {
    // When manifests with no owner field are cached
    const cached = toCachedManifest({ root: ROOT, app: EMPTY });

    // Then the cached copy holds no owner field
    expect(cached).toStrictEqual({ root: ROOT_TEXT, app: null });
  });

  it('As an operator, I see a cached owner that is no address reported, and the product loads with its owner unknown', () => {
    // Given a cached entry whose owner does not parse
    const heard: unknown[] = [];

    // When the cached copy is read back
    const cached = fromCachedManifest(
      { root: ROOT_TEXT, app: null, owner: '5Owner' },
      {
        report: error => {
          heard.push(error);
        },
      },
    );

    // Then the owner is unknown, the manifests still read, and the report heard the parse error
    expect(cached.owner).toBeUndefined();
    expect(cached.root.kind).toBe('ok');
    expect(heard).toEqual([new Error('Address 5Owner is not a 20-byte hex address')]);
  });
});
