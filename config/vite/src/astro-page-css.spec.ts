// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  astroPageOf,
  type ModuleImporters,
  pageGroupName,
  pagesReaching,
  repeatsPrerenderedCss,
} from './astro-page-css.js';

const PAGES = '/app/src/pages/';
const pageOf = astroPageOf(PAGES);

/** A module graph from each module's static and dynamic importers. */
function graph(edges: Record<string, { importers?: string[]; dynamicImporters?: string[] }>): ModuleImporters {
  return id => {
    const edge = edges[id];
    return edge === undefined
      ? null
      : { importers: edge.importers ?? [], dynamicImporters: edge.dynamicImporters ?? [] };
  };
}

describe('astroPageOf', () => {
  it('As a dotli maintainer, a page module and its processed script stand for the page', () => {
    // When
    const page = pageOf(`${PAGES}landing.astro`);
    const script = pageOf(`${PAGES}index.astro?astro&type=script&index=0&lang.ts`);

    // Then
    expect([page, script]).toEqual(['landing', 'index']);
  });

  it("As a dotli maintainer, a page's style block and a component outside the pages stand for no page", () => {
    // When
    const style = pageOf(`${PAGES}index.astro?astro&type=style&index=0&lang.css`);
    const component = pageOf('/app/src/components/Landing.astro');

    // Then
    expect([style, component]).toEqual([undefined, undefined]);
  });
});

describe('pagesReaching', () => {
  it('As a dotli maintainer, CSS a page reaches only through a lazy import still counts for that page', () => {
    // Given the landing imports the error page and the product page loads it on demand
    const importers = graph({
      'ErrorPage.module.css': { importers: ['ui.ts'] },
      'ui.ts': { importers: ['broken-page.ts', 'overlays.ts'] },
      'broken-page.ts': { importers: [`${PAGES}landing.astro`] },
      'overlays.ts': { dynamicImporters: ['lazy.ts'] },
      'lazy.ts': { importers: [`${PAGES}index.astro`] },
    });

    // When
    const pages = pagesReaching('ErrorPage.module.css', importers, pageOf);

    // Then
    expect(pages).toEqual(['index', 'landing']);
  });

  it('As a dotli maintainer, the walk stops at a page, so a page another page imports does not lend it its CSS', () => {
    // Given a page that is itself imported by another page
    const importers = graph({
      'Landing.module.css': { importers: [`${PAGES}landing.astro`] },
      [`${PAGES}landing.astro`]: { importers: [`${PAGES}index.astro`] },
    });

    // When
    const pages = pagesReaching('Landing.module.css', importers, pageOf);

    // Then
    expect(pages).toEqual(['landing']);
  });

  it('As a dotli maintainer, a cycle in the module graph ends the walk', () => {
    // Given two modules importing each other
    const importers = graph({
      'a.module.css': { importers: ['a.ts'] },
      'a.ts': { importers: ['b.ts'] },
      'b.ts': { importers: ['a.ts', `${PAGES}index.astro`] },
    });

    // When
    const pages = pagesReaching('a.module.css', importers, pageOf);

    // Then
    expect(pages).toEqual(['index']);
  });
});

describe('pageGroupName', () => {
  it('As a dotli maintainer, the shared stylesheet is named after every page that links it', () => {
    // When
    const name = pageGroupName(['blog/post', 'index']);

    // Then
    expect(name).toBe('blog-post_index');
  });
});

describe('repeatsPrerenderedCss', () => {
  const prerendered = new Map([
    ['Button.module.css', ['index', 'landing']],
    ['Topbar.module.css', ['index']],
  ]);

  it('As a dotli maintainer, a client chunk whose CSS every page reaching it already links is not emitted again', () => {
    // When
    const repeats = repeatsPrerenderedCss(['Button.module.css'], prerendered, () => ['index', 'landing']);

    // Then
    expect(repeats).toBe(true);
  });

  it('As a dotli maintainer, a client chunk keeps CSS a page reaches that the prerendered pages do not link there', () => {
    // When
    const repeats = repeatsPrerenderedCss(['Topbar.module.css'], prerendered, () => ['landing']);

    // Then
    expect(repeats).toBe(false);
  });

  it('As a dotli maintainer, a client chunk keeps CSS the prerender build never emitted', () => {
    // When
    const repeats = repeatsPrerenderedCss(['Button.module.css', 'global.css'], prerendered, () => ['index']);

    // Then
    expect(repeats).toBe(false);
  });
});
