// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/ui": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
    globals: false,
  },
});
