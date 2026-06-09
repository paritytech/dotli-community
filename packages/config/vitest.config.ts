// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/config": resolve(import.meta.dirname, "src"),
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
  },
});
