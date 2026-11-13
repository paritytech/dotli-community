// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A second TrUAPI worker on the `testing` wasm bundle, the only published one with a signing host. The published
// worker runtime imports the `web` glue by a literal path and Vite keys worker bundles by path, so the signing worker
// has its own entry that imports a marked copy of the runtime with that one specifier rewritten.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import type { Plugin, Rolldown } from 'vite';

export const SIGNING_WORKER_RUNTIME_ID = 'dotli:truapi-signing-worker-runtime';

const PUBLISHED_PACKAGE = '@parity/truapi-host';
const RUNTIME_EXPORT = './worker-runtime';
const MARK = 'truapi-signing';
const WEB_GLUE = './wasm/web/truapi_server.js';
const TESTING_GLUE = './wasm/testing/truapi_server.js';
const TESTING_WASM = '/wasm/testing/truapi_server_bg.wasm';

/**
 * Returns the plugin that resolves the signing worker's runtime id to the marked runtime and names its worker assets.
 * Its resolve fails the build when the published runtime is not installed or does not export it, and its load when the
 * runtime no longer imports the web glue.
 */
export function truapiSigningWorker(): Plugin {
  let root = process.cwd();
  let assetsDir = 'assets';
  return {
    name: 'dotli-truapi-signing-worker',
    // Vite reads worker output options from the main config only, so a worker plugin instance cannot set them.
    config() {
      return {
        worker: {
          rolldownOptions: {
            output: { assetFileNames: asset => getWorkerAssetFileName(asset, assetsDir) },
          },
        },
      };
    },
    configResolved(config) {
      root = config.root;
      assetsDir = config.build.assetsDir;
    },
    resolveId(source) {
      if (source !== SIGNING_WORKER_RUNTIME_ID) {
        return null;
      }
      return `${findPublishedRuntime(root)}?${MARK}`;
    },
    async load(id) {
      const file = getMarkedFile(id);
      if (file === null) {
        return null;
      }
      return rewriteWasmGlue(await readFile(file, 'utf8'), file);
    },
  };
}

/**
 * Returns `code` with its `web` glue import pointed at the `testing` glue. Throws when the literal is gone, so an
 * upstream change fails the build instead of shipping the web glue.
 */
export function rewriteWasmGlue(code: string, id: string): string {
  const quoted = [`"${WEB_GLUE}"`, `'${WEB_GLUE}'`].find(candidate => code.includes(candidate));
  if (quoted === undefined) {
    throw new Error(`${id} no longer imports ${WEB_GLUE}, so the signing worker cannot select the testing bundle`);
  }
  return code.replace(quoted, quoted.replace(WEB_GLUE, TESTING_GLUE));
}

/**
 * Returns the published runtime file, found by walking up from `root`. Throws when no `node_modules` above `root`
 * holds the package, or its manifest has no runtime export. `this.resolve` is not used because in dev it returns the
 * optimizer's pre-bundled copy, which has the web glue inlined.
 */
function findPublishedRuntime(root: string): string {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', PUBLISHED_PACKAGE, 'package.json');
    if (existsSync(manifest)) {
      return readRuntimeFile(manifest);
    }
    if (dirname(dir) === dir) {
      throw new Error(`${PUBLISHED_PACKAGE} was not found in any node_modules above ${root}`);
    }
  }
}

/**
 * Returns a worker asset's file name, with Vite's worker default for all but the testing server wasm. Never throws.
 * Both bundles ship `truapi_server_bg.wasm`, so the signing one gets a name of its own that tells it apart. The
 * bundles' other files are byte-identical, so their shared names keep them one file.
 */
export function getWorkerAssetFileName(asset: Rolldown.PreRenderedAsset, assetsDir: string): string {
  const signing = asset.originalFileNames.some(name => name.endsWith(TESTING_WASM));
  return posix.join(assetsDir, signing ? 'truapi_signing_bg-[hash][extname]' : '[name]-[hash][extname]');
}

/** Returns the runtime file the package's `manifest` exports. Throws when it has no runtime export. */
function readRuntimeFile(manifest: string): string {
  // A published package.json, whose `exports` map has this shape.
  const packageJson = JSON.parse(readFileSync(manifest, 'utf8')) as {
    exports?: Record<string, { import?: string }>;
  };
  const entry = packageJson.exports?.[RUNTIME_EXPORT]?.import;
  if (entry === undefined) {
    throw new Error(`${manifest} has no ${RUNTIME_EXPORT} import export`);
  }
  return join(dirname(manifest), entry);
}

/** The file behind a marked id. Vite may append its own query, such as `v=`. */
function getMarkedFile(id: string): string | null {
  const [file, query] = id.split('?', 2);
  if (file === undefined || query === undefined) {
    return null;
  }
  return new URLSearchParams(query).has(MARK) ? file : null;
}
