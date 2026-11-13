// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { BASE_DOMAIN, withActiveTld } from '@dotli/config';
import { createNavigateTo, type NavigationPage } from './createNavigateTo.js';

type Params = {
  /** The host's local root, or null on a deployed tab. `localhost` by default. */
  localRoot?: string | null;
  /** The tab's protocol, `http:` by default. */
  protocol?: string;
};

type HandOffCase = {
  /** The host's local root, or null on a deployed tab. */
  localRoot: string | null;
  /** The tab's protocol. */
  protocol: string;
  /** The product or localhost app the product opens. */
  url: string;
  /** Where the current tab moves. */
  target: string;
};

const PORT = '3000';

describe('OpenUrl host callback', () => {
  it.each<HandOffCase>([
    // Another dotNS product
    {
      localRoot: 'localhost',
      protocol: 'http:',
      url: `https://${withActiveTld('dim2')}`,
      target: `http://dim2.localhost:${PORT}`,
    },
    // A path of another product, whose path, query and hash survive
    {
      localRoot: 'localhost',
      protocol: 'http:',
      url: `polkadot://${withActiveTld('dim2')}/play?round=3#top`,
      target: `http://dim2.localhost:${PORT}/play?round=3#top`,
    },
    // A localhost product, which moves into the host proxy path
    {
      localRoot: 'localhost',
      protocol: 'http:',
      url: 'localhost:5199/path?q=1',
      target: `http://localhost:${PORT}/localhost:5199/path?q=1`,
    },
    // Another dotNS product from a deployed tab, which moves to its subdomain of the deployed domain
    {
      localRoot: null,
      protocol: 'https:',
      url: `https://${withActiveTld('dim2')}/play`,
      target: `https://dim2.${BASE_DOMAIN}/play`,
    },
  ])(
    'As a product user under $localRoot, I hand off to $url and the current tab moves to $target',
    async ({ localRoot, protocol, url, target }) => {
      // Given a product under the local root
      const { navigateTo, assign, open } = createDevTab({ localRoot, protocol });

      // When it opens the product or localhost app
      await navigateTo(url);

      // Then the tab moves to that target, with no new tab
      expect(assign.mock.calls).toEqual([[target]]);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('As a product user, I open a website and it opens in a new tab that cannot reach back into dotli', async () => {
    // Given
    const { navigateTo, assign, open } = createDevTab();

    // When
    await navigateTo('https://example.com/path');
    await navigateTo('example.dot/path');

    // Then
    expect(assign).not.toHaveBeenCalled();
    expect(open.mock.calls).toEqual([
      ['https://example.com/path', { target: '_blank', features: 'noopener' }],
      ['example.dot/path', { target: '_blank', features: 'noopener' }],
    ]);
  });
});

/** Navigation on a dev tab on port 3000 under `localRoot`, with the spies that record where it is sent. */
function createDevTab({ localRoot = 'localhost', protocol = 'http:' }: Params = {}) {
  const assign = vi.fn<(url: string) => void>();
  const open = vi.fn<NavigationPage['open']>();
  const navigateTo = createNavigateTo({
    page: { location: () => ({ protocol, port: PORT, assign }), localRoot, open },
  });
  return { navigateTo, assign, open };
}
