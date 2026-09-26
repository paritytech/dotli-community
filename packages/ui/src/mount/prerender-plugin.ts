// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin: server-render a Solid entry into index.html.
//
// The entry is loaded through Vite's own SSR module loading, so its JSX is
// compiled by `@solidjs/vite-plugin` in SSR mode with the app's aliases and
// defines. In `vite dev` the running dev server loads it; in `vite build`
// there is no dev server, so a short-lived one is created from the same config
// file and closed after the render. A missing placeholder or entry fails the
// build: shipping an empty shell must never be silent.
//
// Imported by apps/host/vite.config.ts, alongside `prodNoAnalyticsAliases`.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";

/**
 * Set to `"1"` in `process.env` while the build-time render server loads its
 * config. The config reads it to compile Solid in production posture there
 * (`solid({ dev: false })`, no `development` resolve condition): that server
 * is a `serve`-command server, so `@solidjs/vite-plugin` would otherwise pick
 * dev posture, while the client bundle it has to match is a production build.
 */
export const PRERENDER_BUILD_SERVER_ENV = "DOTLI_PRERENDER_BUILD_SERVER";

/**
 * The subset of a resolved Vite server's config this file's posture check
 * reads. `ResolvedConfig.ssr.resolve.conditions` is where `@solidjs/vite-plugin`
 * (via its `configEnvironment` hook) lists the ssr environment's resolve
 * conditions, adding `"development"` there only when it compiled Solid in dev
 * posture (verified empirically: with `solid({ dev: false })` the condition
 * is absent; without it, an inner server created via `createServer` - always
 * `command: "serve"` - defaults to dev posture and the condition is present).
 */
interface ServerWithSsrPosture {
  config: {
    ssr?: { resolve?: { conditions?: readonly string[] } };
  };
}

/**
 * Throws if `server`'s ssr environment resolved with the `"development"`
 * condition, meaning `@solidjs/vite-plugin` compiled Solid in dev posture.
 * The build-time render server's client bundle counterpart is always a
 * production build, so a dev-posture render would silently prerender markup
 * that doesn't match what the shipped client hydrates against. This can
 * happen even though {@link PRERENDER_BUILD_SERVER_ENV} is set correctly
 * around `createServer` - e.g. `configLoader: "native"` serving a config
 * module cached from a previous, differently-flagged resolution, or
 * `NODE_ENV=development` steering `@solidjs/vite-plugin`'s own posture
 * detection - so this checks the server's actual resolved posture rather
 * than trusting the env flag was honored.
 */
export function assertProductionSsrPosture(server: ServerWithSsrPosture): void {
  const conditions = server.config.ssr?.resolve?.conditions ?? [];
  if (conditions.includes("development")) {
    throw new Error(
      "[prerender] the build-time render server resolved its ssr environment " +
        'with the "development" condition, meaning Solid compiled in dev ' +
        "posture; it must render in production posture to match the " +
        'production client bundle. A cached config (configLoader: "native") ' +
        "or NODE_ENV=development can defeat the " +
        `${PRERENDER_BUILD_SERVER_ENV} env flag that @solidjs/vite-plugin's ` +
        "`dev` option depends on - check that first.",
    );
  }
}

/**
 * Creates the build-time render server with {@link PRERENDER_BUILD_SERVER_ENV}
 * set while its config file is loaded and resolved, then restores the
 * variable, so nothing else in this process sees it. Asserts the server
 * actually resolved to production ssr posture (see
 * {@link assertProductionSsrPosture}) before handing it back, closing it
 * first if the assertion fails so a posture bug doesn't also leak the
 * server.
 */
async function createBuildRenderServer(
  config: Parameters<typeof createServer>[0],
): Promise<ViteDevServer> {
  const previous = process.env[PRERENDER_BUILD_SERVER_ENV];
  process.env[PRERENDER_BUILD_SERVER_ENV] = "1";
  try {
    const server = await createServer(config);
    try {
      assertProductionSsrPosture(server);
    } catch (postureError) {
      try {
        await server.close();
      } catch (closeError) {
        // The posture error is the one worth surfacing; a close failure on
        // top of it would otherwise silently replace it.
        console.error(
          "[prerender] server.close() also failed after a posture assertion failure",
          closeError,
        );
      }
      throw postureError;
    }
    return server;
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, PRERENDER_BUILD_SERVER_ENV);
    } else {
      process.env[PRERENDER_BUILD_SERVER_ENV] = previous;
    }
  }
}

export interface PrerenderOptions {
  /** Marker in the HTML replaced by the rendered markup, e.g. `<!--ssr:shell-->`. */
  placeholder: string;
  /** Absolute path of the server entry module. */
  entry: string;
  /** Export of `entry` that returns the rendered HTML string. */
  exportName: string;
  /**
   * Basename of the HTML entry to transform, e.g. `index.html`. A build or
   * dev server can process several HTML entries (this monorepo's other apps,
   * for instance); every other one is returned unchanged.
   * @default "index.html"
   */
  filter?: string;
}

/**
 * Replaces the single occurrence of `placeholder` in `html` with `rendered`,
 * inserted verbatim. Throws if the placeholder is missing or appears more than
 * once.
 */
export function injectPrerendered(
  html: string,
  placeholder: string,
  rendered: string,
): string {
  const parts = html.split(placeholder);
  if (parts.length === 1) {
    throw new Error(
      `[prerender] placeholder "${placeholder}" not found in index.html`,
    );
  }
  if (parts.length > 2) {
    throw new Error(
      `[prerender] placeholder "${placeholder}" appears ${String(parts.length - 1)} times in index.html; expected exactly once`,
    );
  }
  return parts[0] + rendered + parts[1];
}

async function renderWith(
  server: ViteDevServer,
  options: PrerenderOptions,
): Promise<string> {
  const mod = await server.ssrLoadModule(options.entry);
  const render: unknown = mod[options.exportName];
  if (typeof render !== "function") {
    throw new Error(
      `[prerender] ${options.entry} has no function export "${options.exportName}"`,
    );
  }
  const rendered: unknown = await (render as () => unknown)();
  if (typeof rendered !== "string") {
    throw new Error(
      `[prerender] ${options.exportName}() in ${options.entry} did not return a string`,
    );
  }
  if (rendered.trim() === "") {
    throw new Error(
      `[prerender] ${options.exportName}() in ${options.entry} returned an empty string; shipping an empty shell must never be silent`,
    );
  }
  return rendered;
}

/**
 * The build-time render server never serves client modules, so its client
 * dependency optimizer must not run: it would rewrite the dev server's
 * pre-bundle cache (forcing a re-optimize on the next `vite dev`) and warn
 * about `optimizeDeps.include` entries the host cannot resolve. Other plugins
 * (`@solidjs/vite-plugin`) add to `include` in their `config` hooks, so this
 * clears it after them; Vite disables the optimizer when discovery is off and
 * `include` is empty.
 */
function disableClientDepsOptimizer(): Plugin {
  return {
    name: "dotli-prerender-no-deps-optimizer",
    enforce: "post",
    config(config) {
      config.optimizeDeps = {
        ...config.optimizeDeps,
        noDiscovery: true,
        include: [],
      };
    },
  };
}

/**
 * Server-renders `options.entry` and puts the result in place of
 * `options.placeholder` in index.html, in both `vite dev` and `vite build`.
 */
export function prerenderPlugin(options: PrerenderOptions): Plugin {
  let buildServerConfig: Parameters<typeof createServer>[0] | undefined;

  return {
    name: "dotli-prerender",
    configResolved(config) {
      if (!existsSync(options.entry)) {
        throw new Error(`[prerender] entry not found: ${options.entry}`);
      }
      if (config.command === "build") {
        if (config.configFile === undefined) {
          // Without a config file, the inner server below would start with
          // only `disableClientDepsOptimizer()` in its plugin list: no
          // solid(), no aliases. It would "succeed" at rendering something,
          // silently wrong, rather than fail loudly.
          throw new Error(
            "[prerender] no configFile resolved for this build; the inner SSR render server needs it to load the same plugins (solid(), aliases, ...) as the build itself",
          );
        }
        // The same config file (plugins, aliases, defines) and mode as this
        // build, as an SSR-only middleware server: no HTTP listener, HMR or
        // file watching.
        buildServerConfig = {
          ...config.inlineConfig,
          configFile: config.configFile,
          root: config.root,
          mode: config.mode,
          logLevel: "warn",
          appType: "custom",
          server: { middlewareMode: true, hmr: false, ws: false, watch: null },
          plugins: [disableClientDepsOptimizer()],
        };
      }
    },
    transformIndexHtml: {
      // After Vite's own HTML processing, so the markup lands verbatim.
      order: "post",
      async handler(html, ctx) {
        if (basename(ctx.filename) !== (options.filter ?? "index.html")) {
          return html;
        }
        let rendered: string;
        if (ctx.server) {
          rendered = await renderWith(ctx.server, options);
        } else {
          if (!buildServerConfig) {
            throw new Error("[prerender] no dev server and not a build");
          }
          const server = await createBuildRenderServer(buildServerConfig);
          try {
            rendered = await renderWith(server, options);
          } catch (renderError) {
            try {
              await server.close();
            } catch (closeError) {
              // The render error is the one worth surfacing; a close
              // failure on top of it would otherwise silently replace it.
              console.error(
                "[prerender] server.close() also failed after a render error",
                closeError,
              );
            }
            throw renderError;
          }
          await server.close();
        }
        return injectPrerendered(html, options.placeholder, rendered);
      },
    },
  };
}
