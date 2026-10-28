// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SIGNING_WORKER_RUNTIME_ID,
  rewriteWasmGlue,
  truapiSigningWorker,
  getWorkerAssetFileName,
} from './truapiSigningWorker.js';
import type { Rolldown } from 'vite';

/** The plugin's hooks, as the cases call them. */
type Hooks = {
  /** Takes the resolved config's root and assets folder. */
  configResolved: (config: { root: string; build: { assetsDir: string } }) => void;
  /** Returns the marked runtime's file for its id, or `null` for any other id. Throws when it is not installed. */
  resolveId: (source: string) => string | null;
  /** Resolves to the rewritten marked runtime, or `null` for any other module. */
  load: (this: unknown, id: string) => Promise<string | null>;
};

// Hoisted to the workspace root.
const PACKAGE_DIST = resolve(import.meta.dirname, '../../../node_modules/@parity/truapi-host/dist');
const PUBLISHED_RUNTIME = `${PACKAGE_DIST}/worker-runtime.js`;

/** Returns the plugin's hooks, typed as the cases call them. */
function readHooks(plugin: ReturnType<typeof truapiSigningWorker>): Hooks {
  // The plugin defines each hook as a plain function, which Vite types as a function-or-object hook.
  return {
    configResolved: plugin.configResolved as Hooks['configResolved'],
    resolveId: plugin.resolveId as Hooks['resolveId'],
    load: plugin.load as Hooks['load'],
  };
}

describe('truapiSigningWorker', () => {
  it('As a dotli developer, I rewrite the marked runtime and it imports the testing glue instead of the web glue', () => {
    // Given
    const code = 'const wasmModulePromise = import("./wasm/web/truapi_server.js");';

    // When
    const rewritten = rewriteWasmGlue(code, 'worker-runtime.js');

    // Then
    expect(rewritten).toBe('const wasmModulePromise = import("./wasm/testing/truapi_server.js");');
  });

  it('As a dotli developer, I rewrite a runtime that stops naming the web glue and the build fails', () => {
    // Given
    const code = 'const wasmModulePromise = import("./wasm/other.js");';

    // When
    const rewrite = (): string => rewriteWasmGlue(code, 'worker-runtime.js');

    // Then
    expect(rewrite).toThrow(/no longer imports/);
  });

  it('As a dotli developer, I rewrite the published runtime and it still names the web glue to replace', () => {
    // Given
    const code = readFileSync(PUBLISHED_RUNTIME, 'utf8');

    // When
    const rewritten = rewriteWasmGlue(code, PUBLISHED_RUNTIME);

    // Then
    expect(rewritten).toContain('./wasm/testing/truapi_server.js');
    expect(rewritten).not.toContain('./wasm/web/truapi_server.js');
  });

  it('As a dotli developer, I load modules through the plugin and only the marked runtime is rewritten', async () => {
    // Given
    const { load } = readHooks(truapiSigningWorker());

    // When
    const plain = await load.call({}, PUBLISHED_RUNTIME);
    const marked = await load.call({}, `${PUBLISHED_RUNTIME}?truapi-signing&v=abc`);

    // Then
    expect(plain).toBeNull();
    expect(marked).toContain('./wasm/testing/truapi_server.js');
  });

  it('As a dotli developer, I resolve the marked id and get the real published runtime file', () => {
    // Given
    const hooks = readHooks(truapiSigningWorker());
    hooks.configResolved({
      root: resolve(import.meta.dirname, '../../../apps/host'),
      build: { assetsDir: 'assets' },
    });

    // When
    const id = hooks.resolveId(SIGNING_WORKER_RUNTIME_ID);

    // Then
    expect(id).toBe(`${PUBLISHED_RUNTIME}?truapi-signing`);
  });

  it('As a dotli developer, I resolve the marked id where the published package is not installed and the build fails loudly', () => {
    // Given
    const hooks = readHooks(truapiSigningWorker());
    hooks.configResolved({ root: '/', build: { assetsDir: 'assets' } });

    // When
    const resolveId = (): string | null => hooks.resolveId(SIGNING_WORKER_RUNTIME_ID);

    // Then
    expect(resolveId).toThrow(/was not found/);
  });

  it('As a dotli developer, I name the worker wasm assets and the testing server wasm gets its own name while the others keep the names Vite gives them', () => {
    // Given
    const asset = (originalFileName: string): Rolldown.PreRenderedAsset => ({
      type: 'asset',
      names: ['truapi_server_bg.wasm'],
      originalFileNames: [originalFileName],
      source: new Uint8Array(),
    });

    // When
    const testing = getWorkerAssetFileName(asset(`${PACKAGE_DIST}/wasm/testing/truapi_server_bg.wasm`), 'assets');
    const web = getWorkerAssetFileName(asset(`${PACKAGE_DIST}/wasm/web/truapi_server_bg.wasm`), 'assets');
    const verifiable = getWorkerAssetFileName(
      asset(`${PACKAGE_DIST}/wasm/testing/truapi_verifiable_bg.wasm`),
      'assets',
    );

    // Then
    expect(testing).toBe('assets/truapi_signing_bg-[hash][extname]');
    expect(web).toBe('assets/[name]-[hash][extname]');
    expect(verifiable).toBe('assets/[name]-[hash][extname]');
  });
});
