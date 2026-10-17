// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Builds each page script that speaks the real protocol wire into one classic script with no exports, which runs on
// its own wherever it is loaded.

import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { build } from 'vite';
import { WIRE_BUNDLES, WIRE_OUT_DIR } from './helpers/wire-bundles.js';

export default async function globalSetup(): Promise<void> {
  await rm(WIRE_OUT_DIR, { recursive: true, force: true });
  for (const bundle of WIRE_BUNDLES) {
    await build({
      configFile: false,
      envDir: false,
      mode: 'production',
      root: import.meta.dirname,
      publicDir: false,
      logLevel: 'warn',
      build: {
        outDir: WIRE_OUT_DIR,
        emptyOutDir: false,
        copyPublicDir: false,
        reportCompressedSize: false,
        minify: false,
        lib: {
          entry: bundle.entry,
          formats: ['iife'],
          // Required for the format. An entry with no exports leaves it unused.
          name: 'dotliWire',
          fileName: () => basename(bundle.path),
        },
      },
    });
  }
}
