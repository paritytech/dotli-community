// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { resolve } from "node:path";
import { stripClientTemplatesPlugin } from "./src/mount/strip-client-templates-plugin.ts";

// Hydration tests need components compiled hydratable, the way the host build
// compiles them (`solid({ ssr: true })` in apps/host/vite.config.ts). In test
// mode @solidjs/vite-plugin always compiles non-hydratable, so the hydration
// project runs under its own mode. It also drops the shell's client templates
// the way the host build does, so the tests hydrate the module that ships.
// The islands swap test runs here too: it hydrates the real shell first, as
// the host boots, and client-renders islands compiled the way the host
// compiles them.
const HYDRATION_TESTS = [
  "tests/mount/hydrate-shell.test.tsx",
  "tests/mount/hydrate-root.test.tsx",
  "tests/components/shell/islands.test.tsx",
];

const shared = {
  resolve: {
    alias: {
      "@dotli/ui": resolve(import.meta.dirname, "src"),
    },
  },
  define: {
    // getEnabledNetworks() requires VITE_NETWORKS (no default by design); the
    // test build supplies it the same way a deployment does.
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v2,previewnet"',
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        plugins: [solid()],
        test: {
          name: "ui",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: HYDRATION_TESTS,
          environment: "happy-dom",
          globals: false,
        },
      },
      {
        ...shared,
        mode: "hydration",
        // Outside test mode the plugin no longer adds the `browser`
        // condition itself.
        resolve: { ...shared.resolve, conditions: ["browser"] },
        plugins: [
          solid({ ssr: true }),
          stripClientTemplatesPlugin({
            files: [
              resolve(import.meta.dirname, "src/components/shell/Shell.tsx"),
            ],
          }),
        ],
        test: {
          name: "hydration",
          include: HYDRATION_TESTS,
          environment: "happy-dom",
          globals: false,
        },
      },
    ],
  },
});
