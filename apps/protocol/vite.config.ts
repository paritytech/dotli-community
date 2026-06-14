// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
import { prodNoAnalyticsAliases } from "../../packages/metrics/src/prod-no-analytics-aliases";

const OUT_DIR = "dist";

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

const PACKAGES = resolve(import.meta.dirname, "../../packages");

export default defineConfig({
  envDir: resolve(import.meta.dirname, "../.."),
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [wasm(), sentry()],
  resolve: {
    alias: {
      ...prodNoAnalyticsAliases(process.env.VITE_APP_ENV === "production"),
      "@dotli/config": resolve(PACKAGES, "config/src"),
      "@dotli/metrics": resolve(PACKAGES, "metrics/src"),
      "@dotli/shared": resolve(PACKAGES, "shared/src"),
      "@dotli/storage": resolve(PACKAGES, "storage/src"),
      "@dotli/resolver": resolve(PACKAGES, "resolver/src"),
      "@dotli/protocol": resolve(PACKAGES, "protocol/src"),
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("protocol"),
  },
  optimizeDeps: {
    exclude: ["@polkadot-api/wasm-executor"],
  },
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: "hidden",
  },
  server: {
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
});
