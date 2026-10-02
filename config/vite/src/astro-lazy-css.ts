// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy chunks' CSS under Astro. Astro gives a page every stylesheet it finds
// by walking up from each CSS module to the page, through dynamic imports as
// well as static ones, so a chunk the page imports on demand has its CSS
// linked (or inlined) at boot. Astro has no option for this, and a dynamic
// import is the only way to reach such a module. Under plain Vite a
// dynamically imported chunk loads its own CSS before it runs, and this
// brings that back.
//
// It leans on three Astro internals, and the build fails if any of them
// stops holding:
// - The plugin `astro:rollup-plugin-build-css` exists, with a plain
//   `generateBundle` (checked when the config resolves).
// - That plugin reads the module graph through `this.getModuleInfo`, so the
//   static-imports-only view applies. If it stops, the lazy sheets are
//   linked or inlined at boot again, and the build fails on a page that
//   links one or inlines its content (an inlined sheet also leaves the
//   output, which fails first).
// - Its orphan rule keeps a sheet a chunk lists in `importedAssets`. If it
//   stops, the lazy sheets are dropped, and the build fails on a sheet
//   missing from the output.
// The build also fails when a class the prerendered pages use is defined
// only in a lazy sheet, which would paint unstyled until that chunk loads.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { Plugin, Rolldown } from 'vite';

type OutputChunk = Rolldown.OutputChunk;

/** The Astro plugin that hands each page its stylesheets. */
const ASTRO_CSS_PLUGIN = 'astro:rollup-plugin-build-css';

type GenerateBundle = (this: unknown, ...args: unknown[]) => unknown;

interface ModuleInfoLike {
  readonly dynamicImporters: readonly string[];
}

interface ContextLike {
  getModuleInfo(id: string): ModuleInfoLike | null;
}

/** The class names a stylesheet's selectors name. */
function classesOf(css: string): Set<string> {
  return new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1] ?? ''));
}

/** `css` without its comments (Vite marks a sheet with one until it is written). */
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '').trim();
}

/** The HTML files under `dir`, at any depth. */
async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => join(entry.parentPath, entry.name));
}

/**
 * Fails the build when a page links a lazy sheet, inlines its content, or
 * uses a class that only a lazy sheet defines. `sheets` holds every client
 * stylesheet's content by file name, and `lazy` the lazy ones' file names.
 */
async function checkPages(dir: string, sheets: ReadonlyMap<string, string>, lazy: ReadonlySet<string>): Promise<void> {
  const lazyClasses = new Set([...lazy].flatMap(file => [...classesOf(sheets.get(file) ?? '')]));
  const lazyContents = [...lazy]
    .map(file => [file, withoutComments(sheets.get(file) ?? '')] as const)
    .filter(([, content]) => content !== '');
  // Hashed asset names are unique, so a link's basename names its sheet.
  const sheetByBasename = new Map([...sheets.keys()].map(file => [file.slice(file.lastIndexOf('/') + 1), file]));
  for (const page of await htmlFiles(dir)) {
    const html = await readFile(page, 'utf8');
    const fail = (problem: string): never => {
      throw new Error(`astroLazyCss: ${page} ${problem}: check astroLazyCss against this Astro version`);
    };
    let boot = '';
    for (const [, inline = ''] of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      boot += inline;
    }
    for (const [link = ''] of html.matchAll(/<link\b[^>]*>/g)) {
      const href = /\shref="([^"]+)"/.exec(link)?.[1];
      if (!/\srel="stylesheet"/.test(link) || href === undefined) {
        continue;
      }
      const file = sheetByBasename.get(href.slice(href.lastIndexOf('/') + 1));
      if (file !== undefined && lazy.has(file)) {
        fail(`links the lazy sheet ${file}`);
      }
      boot += file === undefined ? '' : (sheets.get(file) ?? '');
    }
    const text = withoutComments(html);
    for (const [file, content] of lazyContents) {
      if (text.includes(content)) {
        fail(`inlines the lazy sheet ${file}`);
      }
    }
    const bootClasses = classesOf(boot);
    for (const [, list = ''] of html.matchAll(/\sclass="([^"]*)"/g)) {
      for (const name of list.split(/\s+/)) {
        if (name !== '' && lazyClasses.has(name) && !bootClasses.has(name)) {
          fail(`uses the class ${name}, which only a lazy sheet defines`);
        }
      }
    }
  }
}

/**
 * The module as Astro's stylesheet walk sees it: only the dynamic importers
 * that are Astro's own virtual modules (`\0...`) are kept, as Astro imports
 * each page dynamically from one and recognizes a page by it.
 */
function withoutDynamicImporters(info: ModuleInfoLike): ModuleInfoLike {
  return new Proxy(info, {
    get: (target, key, receiver) =>
      key === 'dynamicImporters'
        ? target.dynamicImporters.filter(id => id.startsWith('\0'))
        : (Reflect.get(target, key, receiver) as unknown),
  });
}

/** The plugin context Astro's stylesheet walk runs with. */
function staticImportsOnly(context: ContextLike): ContextLike {
  return new Proxy(context, {
    get: (target, key) => {
      if (key === 'getModuleInfo') {
        return (id: string) => {
          const info = target.getModuleInfo(id);
          return info === null ? null : withoutDynamicImporters(info);
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as GenerateBundle).bind(target) : value;
    },
  });
}

/**
 * Pages link the CSS of what they import statically, and a chunk imported
 * on demand loads its CSS with it (Vite's preload of a dynamic import):
 * - Astro's walk from a CSS module to the pages follows static imports.
 * - Astro drops a stylesheet that no page links unless a chunk lists it
 *   among its assets, so each client chunk the page loads only on demand
 *   lists its CSS there too. A chunk the page loads up front keeps Astro's
 *   handling: the page's stylesheets hold its CSS, and its own copy goes.
 */
export function astroLazyCss(): AstroIntegration {
  /** The CSS file names of the client chunks the page loads on demand. */
  const lazy = new Set<string>();
  /** Every client stylesheet's content, by file name. */
  const sheets = new Map<string, string>();
  /** Records the bundle's stylesheets, as Astro is yet to inline or drop any, and as written. */
  const recordSheets = (bundle: Rolldown.OutputBundle): void => {
    for (const output of Object.values(bundle)) {
      if (output.type === 'asset' && output.fileName.endsWith('.css')) {
        const { source } = output;
        sheets.set(output.fileName, typeof source === 'string' ? source : new TextDecoder().decode(source));
      }
    }
  };
  const plugin: Plugin = {
    name: 'dotli-lazy-css',
    apply: 'build',
    configResolved(config) {
      const css = config.plugins.find(candidate => candidate.name === ASTRO_CSS_PLUGIN);
      const hook = css?.generateBundle;
      if (css === undefined || typeof hook !== 'function') {
        throw new Error(`${ASTRO_CSS_PLUGIN} not found: check astroLazyCss against this Astro version`);
      }
      const generateBundle = hook as GenerateBundle;
      (css as { generateBundle: GenerateBundle }).generateBundle = function (this: unknown, ...args: unknown[]) {
        return generateBundle.apply(staticImportsOnly(this as ContextLike), args);
      };
    },
    generateBundle(_, bundle) {
      if (this.environment.name !== 'client') {
        return;
      }
      const chunks = new Map<string, OutputChunk>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          chunks.set(output.fileName, output);
        }
      }
      // What the page loads up front: the entries (its scripts and islands)
      // and what they import statically. The page's own CSS covers them.
      const boot = new Set<string>();
      const visit = (file: string): void => {
        if (!boot.has(file)) {
          boot.add(file);
          for (const dependency of chunks.get(file)?.imports ?? []) {
            visit(dependency);
          }
        }
      };
      for (const chunk of chunks.values()) {
        if (chunk.isEntry) {
          visit(chunk.fileName);
        }
      }
      for (const chunk of chunks.values()) {
        if (!boot.has(chunk.fileName) && chunk.viteMetadata !== undefined) {
          const { importedCss, importedAssets } = chunk.viteMetadata;
          for (const file of importedCss) {
            importedAssets.add(file);
            lazy.add(file);
          }
        }
      }
      recordSheets(bundle);
    },
    writeBundle(_, bundle) {
      if (this.environment.name !== 'client') {
        return;
      }
      // The page loads its overlays, chat and debug panel on demand, so
      // finding no lazy sheet means Astro stripped them before this ran,
      // and the checks below would pass without checking anything.
      if (lazy.size === 0) {
        throw new Error('astroLazyCss: found no lazy sheet: check astroLazyCss against this Astro version');
      }
      for (const file of lazy) {
        if (!(file in bundle)) {
          throw new Error(
            `astroLazyCss: the lazy sheet ${file} is missing from the output (dropped, or inlined into a page): check astroLazyCss against this Astro version`,
          );
        }
      }
      recordSheets(bundle);
    },
  };
  return {
    name: 'dotli-lazy-css',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [plugin] } });
      },
      'astro:build:done': async ({ dir }) => {
        await checkPages(fileURLToPath(dir), sheets, lazy);
      },
    },
  };
}
