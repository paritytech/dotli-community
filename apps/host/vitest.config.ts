// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scope strictly to the unit-test folder so the Playwright `.spec.ts`
    // suites under tests/{functional,e2e,performance} are never picked up.
    include: ["tests/unit/**/*.test.ts"],
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
