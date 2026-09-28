// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration test boots the real 2 MiB wasm core.
    testTimeout: 30_000,
  },
});
