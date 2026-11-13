// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listEagerChunkPaths, listLoadIslandModules, listStaticImports } from './eagerPathSize.ts';

describe('listEagerChunkPaths', () => {
  it('As a dotli maintainer measuring the eager path, I measure a page and get its module entry and every modulepreload as eager chunks, in document order', () => {
    // Given
    const html = `<head>
      <script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/spans-BBBBBBBB.js">
      <link rel="stylesheet" href="/assets/index-CCCCCCCC.css">
      <link rel="modulepreload" crossorigin href="/assets/client-DDDDDDDD.js">
    </head>`;

    // When
    const paths = listEagerChunkPaths(html);

    // Then
    assert.deepEqual(paths, ['/assets/index-AAAAAAAA.js', '/assets/spans-BBBBBBBB.js', '/assets/client-DDDDDDDD.js']);
  });

  it('As a dotli maintainer measuring the eager path, I measure a page whose tags list attributes in any order or relative paths and every module chunk is counted', () => {
    // Given
    const html = `<script src="./assets/index-AAAAAAAA.js" type="module"></script>
      <link href="./assets/fetch-BBBBBBBB.js" rel="modulepreload">`;

    // When
    const paths = listEagerChunkPaths(html);

    // Then
    assert.deepEqual(paths, ['./assets/index-AAAAAAAA.js', './assets/fetch-BBBBBBBB.js']);
  });

  it('As a dotli maintainer measuring the eager path, I list a chunk named twice and count it once', () => {
    // Given
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" href="/assets/index-AAAAAAAA.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">`;

    // When
    const paths = listEagerChunkPaths(html);

    // Then
    assert.deepEqual(paths, ['/assets/index-AAAAAAAA.js', '/assets/utils-BBBBBBBB.js']);
  });

  it('As a dotli maintainer measuring the eager path, I measure a page with classic scripts and links that are not modules and only the module chunks are counted', () => {
    // Given
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <script src="/legacy.js"></script>
      <link rel="preload" href="/assets/font.woff2">`;

    // When
    const paths = listEagerChunkPaths(html);

    // Then
    assert.deepEqual(paths, ['/assets/index-AAAAAAAA.js']);
  });

  it('As a dotli maintainer measuring the eager path, I measure a page whose module entry carries a data-src and single-quoted attributes and only its src is counted', () => {
    // Given
    const html = `<script data-src="/assets/lazy-EEEEEEEE.js" type='module' src='/assets/index-AAAAAAAA.js'></script>`;

    // When
    const paths = listEagerChunkPaths(html);

    // Then
    assert.deepEqual(paths, ['/assets/index-AAAAAAAA.js']);
  });

  it('As a dotli maintainer measuring the eager path, I measure a page with no module entry and it fails instead of reporting 0 bytes', () => {
    // Given a page with no module script
    const html = '<html><body></body></html>';

    // When
    const list = (): string[] => listEagerChunkPaths(html);

    // Then
    assert.throws(list, /no <script type="module" src>/);
  });
});

describe('listLoadIslandModules', () => {
  it('As a dotli maintainer measuring the eager path, I measure a page with islands and get the component and renderer of each island that hydrates at load, once each', () => {
    // Given
    const html = `<astro-island uid="a" component-url="/assets/Load.AAAAAAAA.js" component-export="Load" renderer-url="/assets/client.BBBBBBBB.js" ssr client="load">
      <astro-island uid="b" component-url="/assets/Idle.CCCCCCCC.js" renderer-url="/assets/client.BBBBBBBB.js" ssr client="idle">
      <astro-island uid="c" component-url="/assets/Other.DDDDDDDD.js" renderer-url="/assets/client.BBBBBBBB.js" client="load">`;

    // When
    const modules = listLoadIslandModules(html);

    // Then
    assert.deepEqual(modules, ['/assets/Load.AAAAAAAA.js', '/assets/client.BBBBBBBB.js', '/assets/Other.DDDDDDDD.js']);
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
