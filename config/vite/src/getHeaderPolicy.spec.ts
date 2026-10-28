// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getHeaderPolicy } from './getHeaderPolicy.js';
import type { Route } from './siteRoutes.js';

/** The bare host's route, which `localhost` reaches. */
const BARE_HOST: Route = { site: 'host', bare: true };

/** A product host's route, which `browse.localhost` reaches. */
const PRODUCT_HOST: Route = { site: 'host', bare: false };

describe('getHeaderPolicy', () => {
  it('As a sandbox page, I am served from my origin and every response is isolated', () => {
    // Given the sandbox's route and the protocol build's route
    const sandbox: Route = { site: 'app', bare: false };
    const protocol: Route = { site: 'protocol', bare: false };

    // When
    const policies = [getHeaderPolicy(sandbox, '/'), getHeaderPolicy(protocol, '/p/assets/a.js')];

    // Then
    expect(policies).toEqual(['isolated', 'isolated']);
  });

  it("As a preview embedder, I open /__preview and only the bare host's page is isolated", () => {
    // Given the bare host's route and a product host's route
    const routes = [BARE_HOST, PRODUCT_HOST];

    // When
    const policies = routes.map(route => getHeaderPolicy(route, '/__preview'));

    // Then
    expect(policies).toEqual(['isolated', 'plain']);
  });

  it('As a user, I open the session windows on the bare host and no page may frame them', () => {
    // Given the session paths
    const paths = ['/s/auth', '/s/signout', '/s/manage', '/s/sign'];

    // When each session path's policy is read on both hosts
    const policies = [
      ...paths.map(path => getHeaderPolicy(BARE_HOST, path)),
      ...paths.map(path => getHeaderPolicy(PRODUCT_HOST, path)),
    ];

    // Then only the bare host's session windows are unframed
    expect(policies).toEqual(['unframed', 'unframed', 'unframed', 'unframed', 'plain', 'plain', 'plain', 'plain']);
  });

  it.each(['/s/%61uth', '/s/%6Danage', '/s/%73ign'])(
    'As a user, I open the percent-encoded session path %s on the bare host and no page may frame it',
    path => {
      // Given the bare host's route
      const route = BARE_HOST;

      // When the policy of the encoded path is read
      const policy = getHeaderPolicy(route, path);

      // Then it is unframed like the plain path
      expect(policy).toBe('unframed');
    },
  );

  it('As a visitor, I send a malformed escape under the session segment and it is not treated as a session window', () => {
    // Given the bare host's route
    const route = BARE_HOST;

    // When its policy is read
    const policy = getHeaderPolicy(route, '/s/%E0%A4%A');

    // Then it is not unframed
    expect(policy).toBe('plain');
  });

  it('As a page, I ask the bare host for a path near the session windows and it is not treated as one', () => {
    // Given the bare host's route
    const route = BARE_HOST;

    // When the policy of a trailing slash, another session segment path and the old path is read
    const policies = ['/s/auth/', '/s/other', '/__session'].map(path => getHeaderPolicy(route, path));

    // Then none of them is unframed
    expect(policies).toEqual(['plain', 'plain', 'plain']);
  });

  it("As a visitor, I load a product host's assets and they carry no COEP", () => {
    // Given a product host's route
    const route = PRODUCT_HOST;

    // When
    const policy = getHeaderPolicy(route, '/assets/w.js');

    // Then
    expect(policy).toBe('plain');
  });

  it("As a preview embedder, I load the bare host's assets and they carry COEP so /__preview can start their workers", () => {
    // Given the bare host's route
    const route = BARE_HOST;

    // When
    const policy = getHeaderPolicy(route, '/assets/w.js');

    // Then
    expect(policy).toBe('worker-coep');
  });
});
