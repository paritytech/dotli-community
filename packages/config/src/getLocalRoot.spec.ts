// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getLocalRoot } from './getLocalRoot.js';

describe('getLocalRoot', () => {
  it('As a developer on a local page in a development build, I open a host and learn which local root it sits under', () => {
    // Given hosts under both local roots
    const hosts = ['localhost', 'browse.localhost', 'shop.app.localhost', 'local.host', 'browse.local.host'];

    // When each local root is read in a development build
    const roots = hosts.map(host => getLocalRoot(host, { dev: true }));

    // Then each host names its own root
    expect(roots).toEqual(['localhost', 'localhost', 'localhost', 'local.host', 'local.host']);
  });

  it('As a user of a production build, I open a local host and localhost is a local root while the public local.host is not', () => {
    // Given hosts under both local roots
    const hosts = ['localhost', 'browse.localhost', 'local.host', 'browse.local.host', 'shop.app.local.host'];

    // When each local root is read in a production build
    const roots = hosts.map(host => getLocalRoot(host, { dev: false }));

    // Then only the localhost hosts have one
    expect(roots).toEqual(['localhost', 'localhost', null, null, null]);
  });

  it('As a user on a deployed page, I open a host off every local root and it has none', () => {
    // Given deployed hosts and lookalikes
    const hosts = ['dot.li', 'browse.dot.li', 'notlocalhost', 'notlocal.host', 'local.host.evil.com', '127.0.0.1'];

    // When each local root is read
    const roots = hosts.map(host => getLocalRoot(host, { dev: true }));

    // Then none has one
    expect(roots).toEqual([null, null, null, null, null, null]);
  });
});
