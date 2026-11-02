// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { getManifestFacts } from './getManifestFacts.js';
import { APP, EMPTY, ROOT } from './testing/manifestFixtures.js';

describe('manifest facts', () => {
  it('As a visitor, I open a product and the page takes its name and versions from its manifests', () => {
    // When
    const facts = getManifestFacts({ root: ROOT, app: APP });

    // Then
    expect(facts).toEqual({ displayName: 'DOOM', manifestVersion: 1, appVersion: [0, 1, 9] });
  });

  it('As a visitor on a product with no manifests, I open it and the page has no facts to show', () => {
    // When
    const facts = getManifestFacts({ root: EMPTY, app: EMPTY });

    // Then
    expect(facts).toEqual({});
  });
});
