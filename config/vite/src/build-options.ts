// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Terser runs first, then rolldown's oxc minifier over its output. The chain beats oxc alone, and oxc strips the
// whitespace Vite leaves in a terser'd worker.
// The tree-shaking assumptions below hold because nothing reads a layout property such as `offsetHeight` for its
// effect.

import type { BuildEnvironmentOptions, Rolldown, TerserOptions } from 'vite';

const TERSER_OPTIONS: TerserOptions = {
  ecma: 2020,
  module: true,
  toplevel: true,
  compress: { ecma: 2020, module: true, toplevel: true, passes: 3 },
  mangle: { module: true, toplevel: true },
  format: { comments: false, ecma: 2020 },
};

const OXC_MINIFY: Rolldown.MinifyOptions = {
  compress: {
    treeshake: {
      propertyReadSideEffects: false,
      unknownGlobalSideEffects: false,
      invalidImportSideEffects: false,
    },
  },
  mangle: { toplevel: true },
  codegen: { removeWhitespace: true },
};

type WorkerRolldownOptions = Omit<Rolldown.RolldownOptions, 'plugins' | 'input' | 'onwarn' | 'preserveEntrySignatures'>;

/**
 * Rolldown options for app and worker bundles.
 * Lazy barrels stop a static re-export of a lazily loaded module from pinning it into the barrel importer's chunk.
 */
export function rolldownOptions(output: Rolldown.OutputOptions = {}): WorkerRolldownOptions {
  return {
    experimental: { lazyBarrel: true },
    treeshake: {
      propertyReadSideEffects: false,
      unknownGlobalSideEffects: false,
    },
    output: { ...output, minify: OXC_MINIFY },
  };
}

/** `build` options for an app bundle. Spread first, then set the rest. */
export function appBuildOptions(output: Rolldown.OutputOptions = {}): BuildEnvironmentOptions {
  return {
    minify: 'terser',
    terserOptions: TERSER_OPTIONS,
    rolldownOptions: rolldownOptions(output),
  };
}
