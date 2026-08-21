// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/shared": resolve(import.meta.dirname, "src"),
      "@dotli/config": resolve(import.meta.dirname, "../config/src"),
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
    // `getEnabledNetworks` requires VITE_NETWORKS, with no default by design,
    // and the dotNS URL parser reads the active network's TLD. paseo-next-v1
    // leads so the default TLD stays `.dot` and the existing fixtures keep
    // their meaning. The paseo and previewnet cases switch network explicitly
    // via `setNetworkOverride`.
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v1,paseo-next-v2,previewnet"',
  },
});
