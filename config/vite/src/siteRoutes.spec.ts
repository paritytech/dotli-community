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

  it('As a user on an old shell on host.localhost, I ask for the protocol build at its root and the lookup keeps my path', () => {
    // Given the protocol build's route, which host.localhost reaches
    const route: Route = { site: 'protocol', bare: false };

    // When the version file is looked up
    const path = getPathInBuild(route, '/host_version.json');

    // Then the path is kept
    expect(path).toBe('/host_version.json');
  });

  it('As a page on localhost, I load a host file and it is looked up under its own path', () => {
    // Given the bare host's route
    const route: Route = { site: 'host', bare: true };

    // When a host file is looked up
    const path = getPathInBuild(route, '/a');

    // Then the path is kept
    expect(path).toBe('/a');
  });
});
