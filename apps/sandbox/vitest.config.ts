// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
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
