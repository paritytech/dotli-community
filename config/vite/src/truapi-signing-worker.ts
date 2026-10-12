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

/** Throws when the literal is gone, so an upstream change fails the build instead of shipping the web glue. */
export function rewriteWasmGlue(code: string, id: string): string {
  const quoted = [`"${WEB_GLUE}"`, `'${WEB_GLUE}'`].find(candidate => code.includes(candidate));
  if (quoted === undefined) {
    throw new Error(`${id} no longer imports ${WEB_GLUE}, so the signing worker cannot select the testing bundle`);
  }
  return code.replace(quoted, quoted.replace(WEB_GLUE, TESTING_GLUE));
}

/** The file behind a marked id. Vite may append its own query, such as `v=`. */
function markedFile(id: string): string | null {
  const [file, query] = id.split('?', 2);
  if (file === undefined || query === undefined) {
    return null;
  }
  return new URLSearchParams(query).has(MARK) ? file : null;
}

/**
 * The published runtime file, found by walking up from `root`. `this.resolve` is not used because in dev it returns
 * the optimizer's pre-bundled copy, which has the web glue inlined.
 */
export function findPublishedRuntime(root: string): string {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', PUBLISHED_PACKAGE, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: Record<string, { import?: string }> };
      const entry = pkg.exports?.[RUNTIME_EXPORT]?.import;
      if (entry === undefined) {
        throw new Error(`${manifest} has no ${RUNTIME_EXPORT} import export`);
      }
      return join(dirname(manifest), entry);
    }
    if (dirname(dir) === dir) {
      throw new Error(`${PUBLISHED_PACKAGE} was not found in any node_modules above ${root}`);
    }
  }
}

/**
 * Worker asset names, with Vite's worker default for all but the testing server wasm. Both bundles ship
 * `truapi_server_bg.wasm`, and the host's service worker must tell the signing one apart to leave it out of its
 * precache. The bundles' other files are byte-identical, so their shared names keep them one file.
 */
export function workerAssetFileName(asset: Rolldown.PreRenderedAsset, assetsDir: string): string {
  const signing = asset.originalFileNames.some(name => name.endsWith(TESTING_WASM));
  return posix.join(assetsDir, signing ? 'truapi_signing_bg-[hash][extname]' : '[name]-[hash][extname]');
}

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
            output: { assetFileNames: asset => workerAssetFileName(asset, assetsDir) },
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
      const file = markedFile(id);
      if (file === null) {
        return null;
      }
      return rewriteWasmGlue(await readFile(file, 'utf8'), file);
    },
  };
}
