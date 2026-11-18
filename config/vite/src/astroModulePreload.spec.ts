// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { addModulePreloads } from './astroModulePreload.js';

const PARAMS = { base: '/app/', page: 'index.html' };

// A client bundle where `settings.js` is reached only by a dynamic import, which `imports` does not list.
const GRAPH = new Map<string, readonly string[]>([
  ['assets/main.js', ['assets/shared.js', 'assets/boot.js']],
  ['assets/boot.js', ['assets/shared.js']],
  ['assets/shared.js', []],
  ['assets/Nav.js', ['assets/shared.js', 'assets/solid.js']],
  ['assets/client.js', ['assets/solid.js']],
  ['assets/solid.js', []],
  ['assets/Menu.js', ['assets/menu.js']],
  ['assets/menu.js', []],
  ['assets/settings.js', []],
]);

const PAGE =
  '<html><head><title>dotli</title></head><body>' +
  '<astro-island uid="a" component-url="/app/assets/Nav.js" renderer-url="/app/assets/client.js" client="load"></astro-island>' +
  '<astro-island uid="b" component-url="/app/assets/Menu.js" renderer-url="/app/assets/client.js" client="idle"></astro-island>' +
  '<script type="module" src="/app/assets/main.js"></script>' +
  '</body></html>';

describe('addModulePreloads', () => {
  it('As a dotli developer, I build a page and its head preloads its entry and load islands with their static imports, once each and entry first', () => {
    // When
    const html = addModulePreloads(PAGE, GRAPH, PARAMS);

    // Then
    expect(html).toBe(
      '<html><head><title>dotli</title>' +
        '<link rel="modulepreload" href="/app/assets/main.js">' +
        '<link rel="modulepreload" href="/app/assets/shared.js">' +
        '<link rel="modulepreload" href="/app/assets/boot.js">' +
        '<link rel="modulepreload" href="/app/assets/Nav.js">' +
        '<link rel="modulepreload" href="/app/assets/client.js">' +
        '<link rel="modulepreload" href="/app/assets/solid.js">' +
        PAGE.slice(PAGE.indexOf('</head>')),
    );
  });

  it('As a dotli developer, I rewrite a page that already holds its preloads and it comes back unchanged', () => {
    // Given
    const rewritten = addModulePreloads(PAGE, GRAPH, PARAMS);

    // When
    const html = addModulePreloads(rewritten, GRAPH, PARAMS);

    // Then
    expect(html).toBe(rewritten);
  });

  it.each([
    [
      'a module the client bundle does not hold',
      '<head></head><script type="module" src="/app/assets/gone.js"></script>',
      'index.html references /app/assets/gone.js, which the client bundle does not hold',
    ],
    [
      'a module outside the base',
      '<head></head><script type="module" src="/other/main.js"></script>',
      'index.html references /other/main.js, outside the base /app/',
    ],
    [
      'no head to hold the links',
      '<script type="module" src="/app/assets/main.js"></script>',
      'index.html has no </head> to put its modulepreload links in',
    ],
  ])(
    'As a dotli developer, I build a page whose markup has %s and the rewrite throws naming the page',
    (_, page, message) => {
      // When
      const rewrite = (): unknown => addModulePreloads(page, GRAPH, PARAMS);

      // Then
      expect(rewrite).toThrow(message);
    },
  );
});
