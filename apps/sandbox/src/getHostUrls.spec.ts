// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { getHostUrls } from './getHostUrls.js';

describe('host urls', () => {
  it.each([
    {
      page: 'https://myapp.app.dot.li',
      dev: false,
      expected: { app: 'https://myapp.dot.li/', landing: 'https://dot.li/' },
    },
    {
      page: 'http://myapp.app.localhost:4002',
      dev: true,
      expected: { app: 'http://myapp.localhost:4001/', landing: 'http://localhost:4001/' },
    },
    {
      page: 'http://myapp.app.localhost:8080',
      dev: false,
      expected: { app: 'http://myapp.localhost:8080/', landing: 'http://localhost:8080/' },
    },
    {
      page: 'https://app.dot.li',
      dev: false,
      expected: { app: 'https://dot.li/', landing: 'https://dot.li/' },
    },
    {
      page: 'https://a.b.app.dot.li',
      dev: false,
      expected: { app: 'https://dot.li/', landing: 'https://dot.li/' },
    },
    {
      page: 'https://elsewhere.example',
      dev: false,
      expected: { app: 'https://dot.li/', landing: 'https://dot.li/' },
    },
  ])(
    "As a visitor on the sandbox page $page (dev: $dev), I get the host's app and landing addresses",
    ({ page, dev, expected }) => {
      // Given the sandbox page's location
      const location = new URL(page);

      // When the sandbox names the host's addresses
      const urls = getHostUrls(location, { baseDomain: 'dot.li', dev });

      // Then each points at the host page that serves it
      expect(urls).toEqual(expected);
    },
  );
});
