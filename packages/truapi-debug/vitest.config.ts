// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/truapi-debug": resolve(import.meta.dirname, "src"),
      "@dotli/config": resolve(import.meta.dirname, "../config/src"),
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
    // withActiveTld() reads the active network, and getEnabledNetworks()
    // requires VITE_NETWORKS with no default by design.
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v2,previewnet"',
  },
});
