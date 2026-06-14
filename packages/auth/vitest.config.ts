// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/auth": resolve(import.meta.dirname, "src"),
      "@dotli/config": resolve(import.meta.dirname, "../config/src"),
      "@dotli/protocol": resolve(import.meta.dirname, "../protocol/src"),
      "@dotli/shared": resolve(import.meta.dirname, "../shared/src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.VITE_APP_DEBUG": '"true"',
    // getEnabledNetworks() requires VITE_NETWORKS (no default by design); the
    // test build supplies it the same way a deployment does.
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v2,previewnet"',
  },
});
