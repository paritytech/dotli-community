// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getPathInBuild, type Route } from './siteRoutes.js';

describe('getPathInBuild', () => {
  it('As a page on localhost, I load a protocol file and it is looked up without the prefix its base adds', () => {
    // Given the protocol build's route
    const route: Route = { site: 'protocol', bare: false };

    // When the protocol paths are looked up
    const paths = [getPathInBuild(route, '/p/assets/x.js'), getPathInBuild(route, '/p/')];

    // Then the prefix is gone
    expect(paths).toEqual(['/assets/x.js', '/']);
  });
});
