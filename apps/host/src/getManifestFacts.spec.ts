// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toRootManifestResult } from '@dotli/resolver';
import { describe, expect, it } from 'vitest';

import { parseH160Address } from './h160Address.js';
import { getManifestFacts } from './getManifestFacts.js';
import { APP, EMPTY, ROOT } from './testing/manifestFixtures.js';

const OWNER = parseH160Address('0x1111111111111111111111111111111111111111');

describe('manifest facts', () => {
  it('As a visitor, I open a product and the page takes its name, description and versions from its manifests', () => {
    // When the facts are taken from a root and an app manifest
    const facts = getManifestFacts({ root: ROOT, app: APP });

    // Then the facts carry the name, the description and both versions
    expect(facts).toEqual({
      displayName: 'DOOM',
      description: 'Doom',
      manifestVersion: 1,
      appVersion: [0, 1, 9],
    });
  });

  it("As a page, I read a root manifest's description into the facts it shows", () => {
    // Given a root manifest with a description
    const root = toRootManifestResult(
      JSON.stringify({
        $v: 1,
        displayName: 'Swap',
        description: 'Trade tokens.',
        icon: { cid: 'bafk', format: 'png' },
      }),
    );

    // When the facts are taken from it
    const facts = getManifestFacts({ root, app: EMPTY });

    // Then the facts carry the description
    expect(facts).toMatchObject({ description: 'Trade tokens.' });
  });

  it.each([
    ['has an owner', { root: EMPTY, app: EMPTY, owner: OWNER }, { owner: OWNER }],
    ['has no owner', { root: EMPTY, app: EMPTY, owner: null }, {}],
    ['has an owner that was not read', { root: EMPTY, app: EMPTY }, {}],
  ])(
    'As a visitor, I open a product that %s and the page takes the owner only when there is one',
    (_case, manifests, expected) => {
      // When the facts are taken from its manifests
      const facts = getManifestFacts(manifests);

      // Then the facts carry the owner only when there is one
      expect(facts).toEqual(expected);
    },
  );

  it('As a visitor on a product with no manifests, I open it and the page has no facts to show', () => {
    // When the facts are taken from them
    const facts = getManifestFacts({ root: EMPTY, app: EMPTY });

    // Then the facts are empty
    expect(facts).toEqual({});
  });
});
