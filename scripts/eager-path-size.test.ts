// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eagerChunkPaths, loadIslandModules, staticImports } from './eager-path-size.ts';

describe('eagerChunkPaths', () => {
  it('As a dotli maintainer measuring the eager path, I count the module entry and every modulepreload, in document order', () => {
    // Given
    const html = `<head>
      <script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/spans-BBBBBBBB.js">
      <link rel="stylesheet" href="/assets/index-CCCCCCCC.css">
      <link rel="modulepreload" crossorigin href="/assets/client-DDDDDDDD.js">
    </head>`;

    // When / Then
    assert.deepEqual(eagerChunkPaths(html), [
      '/assets/index-AAAAAAAA.js',
      '/assets/spans-BBBBBBBB.js',
      '/assets/client-DDDDDDDD.js',
    ]);
  });

  it('As a dotli maintainer measuring the eager path, I read attributes in any order and relative paths', () => {
    // Given
    const html = `<script src="./assets/index-AAAAAAAA.js" type="module"></script>
      <link href="./assets/fetch-BBBBBBBB.js" rel="modulepreload">`;

    // When / Then
    assert.deepEqual(eagerChunkPaths(html), ['./assets/index-AAAAAAAA.js', './assets/fetch-BBBBBBBB.js']);
  });

  it('As a dotli maintainer measuring the eager path, I count a chunk listed twice once', () => {
    // Given
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" href="/assets/index-AAAAAAAA.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">`;

    // When / Then
    assert.deepEqual(eagerChunkPaths(html), ['/assets/index-AAAAAAAA.js', '/assets/utils-BBBBBBBB.js']);
  });

  it('As a dotli maintainer measuring the eager path, I leave out classic scripts and links that are not modules', () => {
    // Given
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <script src="/legacy.js"></script>
      <link rel="preload" href="/assets/font.woff2">`;

    // When / Then
    assert.deepEqual(eagerChunkPaths(html), ['/assets/index-AAAAAAAA.js']);
  });

  it('As a dotli maintainer measuring the eager path, I fail on a page with no module entry instead of reporting 0 bytes', () => {
    // When / Then
    assert.throws(() => eagerChunkPaths('<html><body></body></html>'), /no <script type="module" src>/);
  });
});

describe('loadIslandModules', () => {
  it('As a dotli maintainer measuring the eager path, I count the component and renderer of each island that hydrates at load, once each', () => {
    // Given
    const html = `<astro-island uid="a" component-url="/assets/Load.AAAAAAAA.js" component-export="Load" renderer-url="/assets/client.BBBBBBBB.js" ssr client="load">
      <astro-island uid="b" component-url="/assets/Idle.CCCCCCCC.js" renderer-url="/assets/client.BBBBBBBB.js" ssr client="idle">
      <astro-island uid="c" component-url="/assets/Other.DDDDDDDD.js" renderer-url="/assets/client.BBBBBBBB.js" client="load">`;

    // When / Then
    assert.deepEqual(loadIslandModules(html), [
      '/assets/Load.AAAAAAAA.js',
      '/assets/client.BBBBBBBB.js',
      '/assets/Other.DDDDDDDD.js',
    ]);
  });
});

describe('staticImports', () => {
  it('As a dotli maintainer measuring the eager path, I follow the relative modules imported statically, not dynamic imports or bare packages', () => {
    // Given
    const code = `import{a as b}from"./solid.AAAAAAAA.js";import"./side.BBBBBBBB.js";export{c}from"./re.CCCCCCCC.js";const l=()=>import("./lazy.DDDDDDDD.js");import x from"pkg"`;

    // When / Then
    assert.deepEqual(staticImports(code), ['./solid.AAAAAAAA.js', './side.BBBBBBBB.js', './re.CCCCCCCC.js']);
  });
});
