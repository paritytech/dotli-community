// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 900_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args:
        process.env.DOTLI_WEBGPU === "1"
          ? [
              "--enable-unsafe-webgpu",
              "--enable-features=Vulkan",
              "--use-angle=swiftshader",
              "--use-vulkan=swiftshader",
            ]
          : [],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
