// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, build as viteBuild, type Plugin } from "vite";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
import { prodNoAnalyticsAliases } from "../../packages/metrics/src/prod-no-analytics-aliases";

// Mirror the host's behavior: fall back to git HEAD when CI didn't inject
// `VITE_COMMIT_SHA`, so the SW's baked `__SW_VERSION__` is a real commit in
// dev builds too.
if (!process.env.VITE_COMMIT_SHA) {
  try {
    process.env.VITE_COMMIT_SHA = execSync("git rev-parse HEAD", {
      cwd: import.meta.dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Not a git checkout, leave unset.
  }
}

const OUT_DIR = "dist";

/**
 * Sentry sourcemap upload, skipped on prod (runtime SDK is aliased to a
 * no-op, nothing to attribute) and locally without SENTRY_AUTH_TOKEN
 * (preserves source maps for debugging).
 */
function sentry(): Plugin | false {
  if (process.env.VITE_APP_ENV === "production") return false;
  if (!process.env.SENTRY_AUTH_TOKEN) return false;
  return sentryVitePlugin({
    org: "paritytech",
    project: "dotli",
    telemetry: false,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: process.env.VITE_COMMIT_SHA },
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
  });
}

/**
 * Build the Service Worker as a self-contained ES module bundle.
 */
function buildServiceWorker(): Plugin {
  return {
    name: "build-service-worker",
    apply: "build",
    async closeBundle() {
      // Stamp the SW bundle with the commit SHA (falls back to a dev marker).
      // The page checks this at runtime to detect a stale SW and force an
      // update (see `apps/sandbox/src/main.ts` registerAppServiceWorker).
      // Using `define` guarantees the SHA is inlined as a literal, so the SW
      // bytes actually change between releases (otherwise the browser might
      // skip updating a byte-identical script).
      const swVersion = process.env.VITE_COMMIT_SHA ?? "dev";
      console.log(`\nBuilding Service Worker (app-sw) @ ${swVersion}...`);
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
        resolve: {
          alias: {
            "@dotli/config": resolve(
              import.meta.dirname,
              "../../packages/config/src",
            ),
            "@dotli/shared": resolve(
              import.meta.dirname,
              "../../packages/shared/src",
            ),
          },
        },
        define: {
          __SW_VERSION__: JSON.stringify(swVersion),
        },
        build: {
          emptyOutDir: false,
          outDir: OUT_DIR,
          lib: {
            entry: resolve(import.meta.dirname, "src/app-sw.ts"),
            formats: ["es"],
            fileName: () => "app-sw.js",
          },
          codeSplitting: false,
          sourcemap: false,
          minify: true,
        },
        logLevel: "warn",
      });
      console.log(`Service Worker built -> ${OUT_DIR}/app-sw.js\n`);
    },
  };
}

/**
 * Vite plugin that injects <link rel="modulepreload"> for critical chunks
 * (fetch/P2P and render) so the browser starts downloading them during
 * HTML parse instead of waiting for the entry module to import() them.
 */
function preloadCriticalAssets(): Plugin {
  let resolvedBase = "/";
  return {
    name: "preload-critical-assets",
    configResolved(config) {
      resolvedBase = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];

        const bundleKeys = Object.keys(ctx.bundle);
        const findChunk = (pattern: RegExp) =>
          bundleKeys.find((name) => pattern.test(name));

        const fetchChunk = findChunk(/^assets\/fetch-.*\.js$/);
        const renderChunk = findChunk(/^assets\/render-.*\.js$/);

        const chunks = [fetchChunk, renderChunk].filter(Boolean);
        if (chunks.length === 0) return [];

        return chunks.map((c) => ({
          tag: "link",
          attrs: { rel: "modulepreload", href: `${resolvedBase}${c}` },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

const PACKAGES = resolve(import.meta.dirname, "../../packages");
const SANDBOX_CHECKER_SRC = resolve(PACKAGES, "sandbox-checker/src");

export default defineConfig({
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [wasm(), preloadCriticalAssets(), buildServiceWorker(), sentry()],
  resolve: {
    alias: {
      ...prodNoAnalyticsAliases(process.env.VITE_APP_ENV === "production"),
      "@dotli/config": resolve(PACKAGES, "config/src"),
      "@dotli/metrics": resolve(PACKAGES, "metrics/src"),
      "@dotli/shared": resolve(PACKAGES, "shared/src"),
      "@dotli/storage": resolve(PACKAGES, "storage/src"),
      "@dotli/content": resolve(PACKAGES, "content/src"),
      "@dotli/ui": resolve(PACKAGES, "ui/src"),
      "@dotli/sandbox-checker": SANDBOX_CHECKER_SRC,
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("app"),
  },
  optimizeDeps: {},
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: "hidden",
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
      "Access-Control-Allow-Origin": "*",
    },
  },
});
