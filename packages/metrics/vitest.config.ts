// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    "import.meta.env.VITE_METRICS": '"false"',
  },
});
