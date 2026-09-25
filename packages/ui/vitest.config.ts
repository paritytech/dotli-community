// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@dotli/ui": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    // getEnabledNetworks() requires VITE_NETWORKS (no default by design); the
    // test build supplies it the same way a deployment does.
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v2,previewnet"',
  },
});
