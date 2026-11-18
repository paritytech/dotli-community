// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listEagerChunkPaths, listStaticImports } from './eagerPathSize.ts';

describe('listEagerChunkPaths', () => {
  it('As a dotli maintainer measuring the eager path, I measure a page and get its module entry, every modulepreload and the modules of each island that hydrates at load as eager chunks, entry first and once each', () => {
    // Given a page that preloads its entry and its load island's component again
    const html = `<head>
      <link rel="modulepreload" href="/assets/Load.AAAAAAAA.js">
      <link rel="modulepreload" href="/assets/utils.BBBBBBBB.js">
      <script type="module" src="/assets/index.CCCCCCCC.js"></script>
      <link rel="modulepreload" href="/assets/index.CCCCCCCC.js">
    </head>
    <astro-island uid="a" component-url="/assets/Load.AAAAAAAA.js" renderer-url="/assets/client.DDDDDDDD.js" client="load">`;

    // When
    const paths = listEagerChunkPaths(html, 'index.html');

    // Then
    assert.deepEqual(paths, [
      '/assets/index.CCCCCCCC.js',
      '/assets/Load.AAAAAAAA.js',
      '/assets/utils.BBBBBBBB.js',
      '/assets/client.DDDDDDDD.js',
    ]);
  });

  it('As a dotli maintainer measuring the eager path, I measure a page with no module entry and it fails instead of reporting 0 bytes', () => {
    // Given a page with no module script
    const html = '<html><body></body></html>';

    // When
    const list = (): string[] => listEagerChunkPaths(html, 'index.html');

    // Then
    assert.throws(list, /index.html has no <script type="module" src>/);
  });
});

describe('listStaticImports', () => {
  it("As a dotli maintainer measuring the eager path, I follow a chunk's imports and get only the relative static ones, not dynamic imports or bare packages", () => {
    // Given
    const code = `import{a as b}from"./solid.AAAAAAAA.js";import"./side.BBBBBBBB.js";export{c}from"./re.CCCCCCCC.js";const l=()=>import("./lazy.DDDDDDDD.js");import x from"pkg"`;

    // When
    const imports = listStaticImports(code);

    // Then
    assert.deepEqual(imports, ['./solid.AAAAAAAA.js', './side.BBBBBBBB.js', './re.CCCCCCCC.js']);
  });
});
