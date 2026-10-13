// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro links a prerender chunk's whole stylesheet on every page whose module graph reaches any CSS module in it, and
// the graph runs through package barrels and lazy loaders. Rolldown files a CSS module beside whichever page's code
// it likes, so one page's CSS lands on the other. Astro also links the client build's copy of a chunk's CSS on pages
// whose scripts reach it, and drops that copy only for island chunks, so shared component CSS ships twice.
// Here each prerender stylesheet holds the CSS of one set of pages, and a client chunk's CSS that the prerender build
// already links is not emitted again.

import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { isCSSRequest, type Plugin } from 'vite';

/** The importers of a module, as the bundler reports them. */
export type ModuleImporters = (
  id: string,
) => { readonly importers: readonly string[]; readonly dynamicImporters: readonly string[] } | null;

/**
 * The page an Astro module id stands for, or undefined. A page's processed script stands for its page, so the client
 * build's graph ends at pages too.
 */
export function astroPageOf(pagesDir: string): (id: string) => string | undefined {
  return id => {
    const [path = '', query] = id.split('?');
    if (!path.startsWith(pagesDir) || !path.endsWith('.astro')) {
      return undefined;
    }
    if (query !== undefined && !query.split('&').includes('type=script')) {
      return undefined;
    }
    return path.slice(pagesDir.length, -'.astro'.length);
  };
}

/** The pages that link a module's CSS, walked as Astro walks them: static and dynamic importers, up to a page. */
export function pagesReaching(
  id: string,
  importersOf: ModuleImporters,
  pageOf: (id: string) => string | undefined,
): string[] {
  const pages = new Set<string>();
  const seen = new Set([id]);
  const pending = [id];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const page = pageOf(current);
    if (page !== undefined) {
      pages.add(page);
      continue;
    }
    const info = importersOf(current);
    for (const importer of [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])]) {
      if (!seen.has(importer)) {
        seen.add(importer);
        pending.push(importer);
      }
    }
  }
  return [...pages].sort();
}

/** The prerender chunk for CSS that exactly these pages link. */
export function pageGroupName(pages: readonly string[]): string {
  return pages.map(page => page.replaceAll('/', '-')).join('_');
}

/**
 * Whether a client chunk's CSS only repeats prerendered CSS: every module in it is prerendered, for at least the pages
 * whose scripts reach it.
 */
export function repeatsPrerenderedCss(
  cssModules: readonly string[],
  prerendered: ReadonlyMap<string, readonly string[]>,
  clientPages: (id: string) => readonly string[],
): boolean {
  return cssModules.every(id => {
    const linkedOn = prerendered.get(id);
    return linkedOn !== undefined && clientPages(id).every(page => linkedOn.includes(page));
  });
}

/** Page-exact stylesheets for a multi-page static Astro build. */
export function astroPageCss(): AstroIntegration {
  let pageOf: (id: string) => string | undefined = () => undefined;
  // CSS module id to the pages its prerendered stylesheet is linked on.
  const prerendered = new Map<string, readonly string[]>();

  const plugin: Plugin = {
    name: 'dotli-page-css',
    apply: 'build',
    configEnvironment(name) {
      if (name !== 'prerender') {
        return undefined;
      }
      return {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                groups: [
                  {
                    debugName: 'page-css',
                    name: (id, ctx) => {
                      if (!isCSSRequest(id)) {
                        return null;
                      }
                      const pages = pagesReaching(id, moduleId => ctx.getModuleInfo(moduleId), pageOf);
                      return pages.length === 0 ? null : pageGroupName(pages);
                    },
                  },
                ],
              },
            },
          },
        },
      };
    },
    generateBundle: {
      // Before Astro reads each chunk's CSS to link it on pages.
      order: 'pre',
      handler(_, bundle) {
        const environment = this.environment.name;
        const importersOf: ModuleImporters = id => this.getModuleInfo(id);
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') {
            continue;
          }
          const cssModules = Object.keys(output.modules).filter(id => isCSSRequest(id));
          if (environment === 'prerender') {
            for (const id of cssModules) {
              prerendered.set(id, pagesReaching(id, importersOf, pageOf));
            }
            continue;
          }
          const importedCss = output.viteMetadata?.importedCss;
          if (environment !== 'client' || cssModules.length === 0 || importedCss === undefined) {
            continue;
          }
          const clientPages = (id: string): string[] => pagesReaching(id, importersOf, pageOf);
          if (repeatsPrerenderedCss(cssModules, prerendered, clientPages)) {
            for (const asset of importedCss) {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the bundle is keyed by file name.
              delete bundle[asset];
            }
            importedCss.clear();
          } else if (cssModules.some(id => prerendered.has(id))) {
            this.warn(`${output.fileName} ships CSS the prerendered pages also link, so a page may get it twice`);
          }
        }
      },
    },
  };

  return {
    name: 'dotli-page-css',
    hooks: {
      'astro:config:setup': ({ config, updateConfig }) => {
        pageOf = astroPageOf(fileURLToPath(new URL('pages/', config.srcDir)));
        updateConfig({ vite: { plugins: [plugin] } });
      },
    },
  };
}
