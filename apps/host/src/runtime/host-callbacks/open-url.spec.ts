// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { withActiveTld } from '@dotli/config';
import { createNavigateTo as createPageNavigateTo } from './open-url.js';

const PORT = '3000';

let assign: Mock<(url: string) => void>;
let open: Mock<(url: string, target: string, features: string) => void>;

/** Navigation on a dev tab on port 3000 under `localRoot` that records where it is sent. */
function createNavigateTo(localRoot = 'localhost', protocol = 'http:'): ReturnType<typeof createPageNavigateTo> {
  assign = vi.fn<(url: string) => void>();
  open = vi.fn<(url: string, target: string, features: string) => void>();
  return createPageNavigateTo({ location: () => ({ protocol, port: PORT, assign }), localRoot, open });
}

function spyOnNavigation(): {
  assign: Mock<(url: string) => void>;
  open: Mock<(url: string, target: string, features: string) => void>;
} {
  return { assign, open };
}

describe('OpenUrl host callback', () => {
  it('As a product user, a handoff to another dotNS product moves the current tab', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign, open } = spyOnNavigation();

    // When
    await navigateTo(`https://${withActiveTld('dim2')}`);

    // Then
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`http://dim2.localhost:${PORT}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('As a product user, the path, query and hash of the target product survive the handoff', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign } = spyOnNavigation();

    // When
    await navigateTo(`polkadot://${withActiveTld('dim2')}/play?round=3#top`);

    // Then
    expect(assign).toHaveBeenCalledWith(`http://dim2.localhost:${PORT}/play?round=3#top`);
  });

  it('As a product developer, a handoff to a localhost product moves the current tab into the host proxy path', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign, open } = spyOnNavigation();

    // When
    await navigateTo('localhost:5199/path?q=1');

    // Then
    expect(assign).toHaveBeenCalledWith(`http://localhost:${PORT}/localhost:5199/path?q=1`);
    expect(open).not.toHaveBeenCalled();
  });

  it('As a product user on local.host, I hand off to another dotNS product and the tab moves to its local.host subdomain', async () => {
    // Given a product on local.host
    const navigateTo = createNavigateTo('local.host', 'https:');
    const { assign, open } = spyOnNavigation();

    // When it opens another dotNS product
    await navigateTo(`https://${withActiveTld('dim2')}/play`);

    // Then the tab moves to that product's local.host subdomain
    expect(assign).toHaveBeenCalledWith(`https://dim2.local.host:${PORT}/play`);
    expect(open).not.toHaveBeenCalled();
  });

  it('As a product developer on local.host, I hand off to a localhost product and the tab moves into the local.host proxy path', async () => {
    // Given a product on local.host
    const navigateTo = createNavigateTo('local.host', 'https:');
    const { assign } = spyOnNavigation();

    // When it opens a localhost product
    await navigateTo('localhost:5199/path');

    // Then the tab moves into the local.host proxy path
    expect(assign).toHaveBeenCalledWith(`https://local.host:${PORT}/localhost:5199/path`);
  });

  it('As a dotli integrator, a website opens in a new tab that cannot reach back into dotli', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign, open } = spyOnNavigation();

    // When
    await navigateTo('https://example.com/path');
    await navigateTo('example.dot/path');

    // Then
    expect(assign).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith('https://example.com/path', '_blank', 'noopener');
    expect(open).toHaveBeenCalledWith('example.dot/path', '_blank', 'noopener');
  });
});
