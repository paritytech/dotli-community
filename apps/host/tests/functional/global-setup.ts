// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Builds the protocol's test entry into one classic script, which the fake protocol frame and the message recorder
// load in a page, so both speak the real wire. UMD, not IIFE: Playwright runs an init script inside a function, where
// an IIFE's top-level `var` stays local, and UMD assigns its global on `globalThis`.

import { resolve } from 'node:path';
import { build } from 'vite';

const OUT_DIR = resolve(import.meta.dirname, '.wire');

/** The built script. It defines the global `dotliWire`. */
export const WIRE_BUNDLE_PATH = resolve(OUT_DIR, 'protocol-wire.js');

export default async function globalSetup(): Promise<void> {
  await build({
    configFile: false,
    envDir: false,
    mode: 'production',
    root: import.meta.dirname,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      copyPublicDir: false,
      reportCompressedSize: false,
      minify: false,
      lib: {
        entry: resolve(import.meta.dirname, 'wire/protocol-wire.ts'),
        formats: ['umd'],
        name: 'dotliWire',
        fileName: () => 'protocol-wire.js',
      },
    },
  });
}
