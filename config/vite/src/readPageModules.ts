// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the module references a page Astro built names in its markup, the one place that knows Astro's island
// attributes.

const SCRIPT = /<script\b([^>]*)>/gi;

const LINK = /<link\b([^>]*)>/gi;

const ISLAND = /<astro-island\b([^>]*)>/gi;

/**
 * Reads the module references a built page names, each list in document order: its module entry scripts, its
 * modulepreload links, and the component and renderer of each island that hydrates at load. Throws when an island that
 * hydrates at load has no `component-url`, naming `page` and the island's `uid`.
 */
export function readPageModules(
  html: string,
  page: string,
): { entries: string[]; preloads: string[]; islands: string[] } {
  const entries: string[] = [];
  for (const [, attributes = ''] of html.matchAll(SCRIPT)) {
    const src = readAttribute(attributes, 'src');
    if (src !== null && readAttribute(attributes, 'type') === 'module') {
      entries.push(src);
    }
  }
  const preloads: string[] = [];
  for (const [, attributes = ''] of html.matchAll(LINK)) {
    const href = readAttribute(attributes, 'href');
    if (href !== null && readAttribute(attributes, 'rel') === 'modulepreload') {
      preloads.push(href);
    }
  }
  const islands = [...html.matchAll(ISLAND)].flatMap(([, attributes = '']) => readLoadIsland(attributes, page));
  return { entries, preloads, islands };
}

/** The component and renderer of an island that hydrates at load, and nothing for any other island. */
function readLoadIsland(attributes: string, page: string) {
  if (readAttribute(attributes, 'client') !== 'load') {
    return [];
  }
  const component = readAttribute(attributes, 'component-url');
  if (component === null) {
    const uid = readAttribute(attributes, 'uid') ?? '';
    throw new Error(`${page} has an island with uid '${uid}' that hydrates at load and has no component-url`);
  }
  // Astro writes no renderer-url for a renderer without a client entrypoint, and the island hydrates without one.
  const renderer = readAttribute(attributes, 'renderer-url');
  return renderer === null ? [component] : [component, renderer];
}

function readAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}
