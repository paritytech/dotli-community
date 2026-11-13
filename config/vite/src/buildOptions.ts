// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Terser runs first, then rolldown's oxc minifier over its output. The chain beats oxc alone, and oxc strips the
// whitespace Vite leaves in a terser'd worker.
// The tree-shaking assumptions below hold because nothing reads a layout property such as `offsetHeight` for its
// effect.

import type { BuildEnvironmentOptions, Rolldown, TerserOptions, UserConfig } from 'vite';

type WorkerRolldownOptions = NonNullable<NonNullable<UserConfig['worker']>['rolldownOptions']>;

type Params = {
  /** Output options the bundle adds to the shared ones. */
  output?: Rolldown.OutputOptions;
};

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

/** Returns the `build` options for an app bundle. Spread first, then set the rest. Never throws. */
export function createAppBuildOptions({ output = {} }: Params = {}): BuildEnvironmentOptions {
  return {
    minify: 'terser',
    terserOptions: TERSER_OPTIONS,
    rolldownOptions: createRolldownOptions({ output }),
  };
}

/**
 * Returns the Rolldown options for app and worker bundles. Never throws.
 * Lazy barrels stop a static re-export of a lazily loaded module from pinning it into the barrel importer's chunk.
 */
export function createRolldownOptions({ output = {} }: Params = {}): WorkerRolldownOptions {
  return {
    experimental: { lazyBarrel: true },
    treeshake: {
      propertyReadSideEffects: false,
      unknownGlobalSideEffects: false,
    },
    output: { ...output, minify: OXC_MINIFY },
  };
}
