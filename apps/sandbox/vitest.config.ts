// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [solid()],
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
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.VITE_APP_DEBUG": '"true"',
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v2,previewnet"',
  },
});
