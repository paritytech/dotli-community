// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build options shared by the three app vite configs (and the sandbox's
// service-worker build): maximum minification and lazy barrels.
//
// Minification runs twice. Terser (three compress passes, top-level and
// module-scope mangling) runs first as Vite's minifier, then rolldown's own
// oxc minifier runs over its output. Measured against oxc alone, the chain
// cut the brotli'd eager path by 2-4% per app, and the total by 1-3%. Worker
// bundles take the same `rolldownOptions`. Vite leaves whitespace in a
// terser'd worker, so there the oxc pass is what strips it.
//
// The tree-shaking assumptions below (property and global reads are free of
// side effects) are safe for this codebase: nothing reads a layout property
// such as `offsetHeight` for its effect.

import type { BuildEnvironmentOptions, Rolldown, TerserOptions } from "vite";

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

type WorkerRolldownOptions = Omit<
  Rolldown.RolldownOptions,
  "plugins" | "input" | "onwarn" | "preserveEntrySignatures"
>;

/**
 * Rolldown options for app and worker bundles. The workspace packages are
 * side-effect-free barrels, and lazy barrel mode keeps a barrel's unused
 * re-exports out of the graph: without it, a static re-export of a module
 * that another importer loads lazily pins that module into the barrel
 * importer's chunk.
 */
export function rolldownOptions(
  output: Rolldown.OutputOptions = {},
): WorkerRolldownOptions {
  return {
    experimental: { lazyBarrel: true },
    treeshake: {
      propertyReadSideEffects: false,
      unknownGlobalSideEffects: false,
    },
    output: { ...output, minify: OXC_MINIFY },
  };
}

/** `build` options for an app bundle; spread first, then set the rest. */
export function appBuildOptions(
  output: Rolldown.OutputOptions = {},
): BuildEnvironmentOptions {
  return {
    minify: "terser",
    terserOptions: TERSER_OPTIONS,
    rolldownOptions: rolldownOptions(output),
  };
}
