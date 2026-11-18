// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro writes no modulepreload links into its pages, and Vite's own preload injection skips the HTML Astro writes.
// Without them a cold visit fetches a page's modules one import depth per round trip.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { Plugin } from 'vite';

type Params = {
  /** The base every module reference of the page starts with, as Vite resolved it, such as `/`. */
  base: string;
  /** The page's name, for the error message. */
  page: string;
};

const SCRIPT = /<script\b([^>]*)>/gi;

const LINK = /<link\b([^>]*)>/gi;

const ISLAND = /<astro-island\b([^>]*)>/gi;

/**
 * Returns the integration that writes a modulepreload link into each built page's head for every module the page runs
 * at load. Acts on `astro build` only. Its build-done hook rejects, so the build fails, when a page references a module
 * the client bundle does not hold, naming the page and the reference.
 */
export function astroModulePreload(): AstroIntegration {
  // Each client chunk's file name to the file names of its static imports.
  const graph = new Map<string, readonly string[]>();
  // Vite's default, until the client bundle reports its own.
  let base = '/';
  return {
    name: 'dotli-modulepreload',
    hooks: {
      'astro:config:setup'({ command, updateConfig }) {
        if (command !== 'build') {
          return;
        }
        const capture: Plugin = {
          name: 'dotli-modulepreload:graph',
          applyToEnvironment: environment => environment.name === 'client',
          generateBundle(_, bundle) {
            base = this.environment.config.base;
            for (const output of Object.values(bundle)) {
              if (output.type === 'chunk') {
                graph.set(output.fileName, output.imports);
              }
            }
          },
        };
        updateConfig({ vite: { plugins: [capture] } });
      },
      async 'astro:build:done'({ assets }) {
        for (const url of [...assets.values()].flat()) {
          if (!url.pathname.endsWith('.html')) {
            continue;
          }
          const html = await readFile(url, 'utf8');
          const next = addModulePreloads(html, graph, { base, page: fileURLToPath(url) });
          if (next !== html) {
            await writeFile(url, next);
          }
        }
      },
    },
  };
}

/**
 * Returns `html` with a modulepreload link before `</head>` for each file the page runs at load, each once. Those are
 * its module entry scripts and the component and renderer of each island that hydrates at load, with their static
 * imports in `graph`. The entries and their imports come first. A file the page already preloads gets no second link,
 * so a rewritten page comes back as it is. Throws when a reference does not start with `base`, when it or an import
 * names a file `graph` does not hold, or when the page has no `</head>`.
 */
export function addModulePreloads(html: string, graph: ReadonlyMap<string, readonly string[]>, params: Params): string {
  const { entries, islands } = readLoadModules(html);
  const preloaded = readPreloaded(html);
  const hrefs = [...new Set([...listClosure(entries, graph, params), ...listClosure(islands, graph, params)])]
    .map(file => params.base + file)
    .filter(href => !preloaded.has(href));
  if (hrefs.length === 0) {
    return html;
  }
  const head = html.search(/<\/head>/i);
  if (head === -1) {
    throw new Error(`${params.page} has no </head> to put its modulepreload links in`);
  }
  const links = hrefs.map(href => `<link rel="modulepreload" href="${href}">`).join('');
  return html.slice(0, head) + links + html.slice(head);
}

/** Reads the page's module entries and the modules of its islands that hydrate at load. */
function readLoadModules(html: string) {
  const entries: string[] = [];
  for (const [, attributes = ''] of html.matchAll(SCRIPT)) {
    const src = readAttribute(attributes, 'src');
    if (src !== null && readAttribute(attributes, 'type') === 'module') {
      entries.push(src);
    }
  }
  const islands: string[] = [];
  for (const [, attributes = ''] of html.matchAll(ISLAND)) {
    if (readAttribute(attributes, 'client') !== 'load') {
      continue;
    }
    for (const name of ['component-url', 'renderer-url']) {
      const url = readAttribute(attributes, name);
      if (url !== null) {
        islands.push(url);
      }
    }
  }
  return { entries, islands };
}

function readPreloaded(html: string) {
  const preloaded = new Set<string>();
  for (const [, attributes = ''] of html.matchAll(LINK)) {
    const href = readAttribute(attributes, 'href');
    if (href !== null && readAttribute(attributes, 'rel') === 'modulepreload') {
      preloaded.add(href);
    }
  }
  return preloaded;
}

function listClosure(references: string[], graph: ReadonlyMap<string, readonly string[]>, { base, page }: Params) {
  const files = new Set(
    references.map(reference => {
      if (!reference.startsWith(base)) {
        throw new Error(`${page} references ${reference}, outside the base ${base}`);
      }
      return reference.slice(base.length);
    }),
  );
  // Visits the files it adds, so the set ends as the transitive closure.
  for (const file of files) {
    const imports = graph.get(file);
    if (imports === undefined) {
      throw new Error(`${page} references ${base}${file}, which the client bundle does not hold`);
    }
    for (const dependency of imports) {
      files.add(dependency);
    }
  }
  return files;
}

function readAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}
