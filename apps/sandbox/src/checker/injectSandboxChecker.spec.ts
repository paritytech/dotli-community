// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { injectSandboxChecker } from './injectSandboxChecker.js';

describe('injectSandboxChecker', () => {
  it('As a product developer, I ship a page with its own head script and the checker runs before it', () => {
    // Given a product page with its own head script
    const html = '<html><head><script src="app.js"></script></head></html>';

    // When
    const checked = injectSandboxChecker(html);

    // Then the first thing in the head is the bundled checker, as one classic script
    const first = /^<html><head><script>([\s\S]*?)<\/script><script src="app.js">/.exec(checked);
    expect(first?.[1]).toContain('DOTLI_API_VIOLATION');
    expect(first?.[1]).not.toMatch(/\bimport\b|\bexport\b/);
  });

  it.each([
    { page: 'no head', html: '<p>hello</p>', checked: /^<script>[\s\S]*<\/script><p>hello<\/p>$/ },
    {
      page: 'a doctype and a head with attributes and capitals',
      html: '<!DOCTYPE html><html><HEAD lang="en"><script src="app.js"></script></HEAD></html>',
      checked: /^<!DOCTYPE html><html><HEAD lang="en"><script>[\s\S]*?<\/script><script src="app.js">/,
    },
    {
      page: 'a doctype and no head',
      html: '<!doctype html><p>hello</p>',
      checked: /^<!doctype html><script>[\s\S]*<\/script><p>hello<\/p>$/,
    },
    {
      page: 'a header before its head',
      html: '<header>x</header><head></head>',
      checked: /^<header>x<\/header><head><script>/,
    },
  ])(
    'As a product developer, I ship a page with $page and the checker lands where it runs first',
    ({ html, checked }) => {
      // When
      const injected = injectSandboxChecker(html);

      // Then
      expect(injected).toMatch(checked);
    },
  );
});
