// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only unit tests. The e2e, functional and performance suites are
    // Playwright and have their own configs and runners.
    include: ["tests/unit/**/*.test.ts"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    // On, so the tests assert the real span tree against a fake Sentry rather
    // than the inert no-op handles a stripped build produces.
    "import.meta.env.VITE_METRICS": '"true"',
    "import.meta.env.VITE_RESOLUTION_SAMPLE_RATE": '"1"',
  },
});
