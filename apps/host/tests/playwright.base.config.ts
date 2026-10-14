// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlaywrightTestConfig } from '@playwright/test';

const PORT = '5173';

export const previewServer = {
  command: 'node ../../../../scripts/preview-server.ts',
  url: `http://localhost:${PORT}`,
  reuseExistingServer: true,
  timeout: 30_000,
};

export const baseConfig: PlaywrightTestConfig = {
  use: {
    browserName: 'chromium',
    channel: process.env['CHANNEL'],
    headless: process.env['HEADED'] !== '1',
    bypassCSP: true,
    launchOptions: {
      slowMo: process.env['SLOWMO'] !== undefined && process.env['SLOWMO'] !== '' ? Number(process.env['SLOWMO']) : 0,
      args:
        process.env['DOTLI_WEBGPU'] === '1'
          ? [
              '--enable-unsafe-webgpu',
              '--enable-features=Vulkan',
              '--use-angle=swiftshader',
              '--use-vulkan=swiftshader',
            ]
          : [],
    },
  },
  webServer: previewServer,
};
