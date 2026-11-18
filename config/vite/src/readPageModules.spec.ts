// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readPageModules } from './readPageModules.js';

describe('readPageModules', () => {
  it('As a dotli developer, I read a page and get its module entries, its modulepreloads and the component and renderer of each island that hydrates at load', () => {
    // Given
    const html = `<head>
      <script type="module" crossorigin src="/assets/index.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/spans.js">
      <link rel="stylesheet" href="/assets/index.css">
      <script src="/legacy.js"></script>
      <link rel="preload" href="/assets/font.woff2">
    </head>
    <astro-island uid="a" component-url="/assets/Load.js" component-export="Load" renderer-url="/assets/client.js" ssr client="load">
    <astro-island uid="b" component-url="/assets/Idle.js" renderer-url="/assets/client.js" ssr client="idle">`;

    // When
    const modules = readPageModules(html, 'index.html');

    // Then
    expect(modules).toEqual({
      entries: ['/assets/index.js'],
      preloads: ['/assets/spans.js'],
      islands: ['/assets/Load.js', '/assets/client.js'],
    });
  });

  it('As a dotli developer, I read a page whose tags list attributes in any order, quote them singly or carry look-alike names and only the real attributes count', () => {
    // Given
    const html = `<script data-src="/assets/lazy.js" type='module' src='./assets/index.js'></script>
      <link href="./assets/fetch.js" rel="modulepreload">`;

    // When
    const modules = readPageModules(html, 'index.html');

    // Then
    expect(modules).toEqual({ entries: ['./assets/index.js'], preloads: ['./assets/fetch.js'], islands: [] });
  });
});
