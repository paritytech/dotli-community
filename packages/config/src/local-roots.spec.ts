// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { trustedLocalRoots } from './local-roots.js';

describe('trustedLocalRoots', () => {
  it('As a developer, I run a development build and either local root stands for the root domain', () => {
    // Given a development build
    const dev = true;

    // When the trusted roots are read
    const roots = trustedLocalRoots(dev);

    // Then both local roots are trusted
    expect(roots).toEqual(['localhost', 'local.host']);
  });

  it('As a user of a production build, I reach the root domain only on localhost and never on the public local.host', () => {
    // Given a production build
    const dev = false;

    // When the trusted roots are read
    const roots = trustedLocalRoots(dev);

    // Then only localhost is trusted
    expect(roots).toEqual(['localhost']);
  });
});
