// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SIGNING_WORKER_RUNTIME_ID,
  rewriteWasmGlue,
  truapiSigningWorker,
  workerAssetFileName,
} from '../src/truapi-signing-worker.js';
import type { Rolldown } from 'vite';

// Hoisted to the workspace root.
const PACKAGE_DIST = resolve(import.meta.dirname, '../../../node_modules/@parity/truapi-host/dist');
const PUBLISHED_RUNTIME = `${PACKAGE_DIST}/worker-runtime.js`;

type ConfigResolvedHook = (config: { root: string; build: { assetsDir: string } }) => void;
type ResolveIdHook = (source: string) => string | null;
type LoadHook = (this: unknown, id: string) => Promise<string | null>;

describe('truapiSigningWorker', () => {
  it('As a dotli developer, I rewrite the web glue to the testing glue in the marked runtime', () => {
    // Given
    const code = 'const wasmModulePromise = import("./wasm/web/truapi_server.js");';

    // When
    const rewritten = rewriteWasmGlue(code, 'worker-runtime.js');

    // Then
    expect(rewritten).toBe('const wasmModulePromise = import("./wasm/testing/truapi_server.js");');
  });

  it('As a dotli developer, I fail the build when the runtime stops naming the web glue', () => {
    // Given
    const code = 'const wasmModulePromise = import("./wasm/other.js");';

    // When
    const rewrite = (): string => rewriteWasmGlue(code, 'worker-runtime.js');

    // Then
    expect(rewrite).toThrow(/no longer imports/);
  });

  it('As a dotli developer, I can rely on the published runtime still naming the web glue', () => {
    // Given
    const code = readFileSync(PUBLISHED_RUNTIME, 'utf8');

    // When
    const rewritten = rewriteWasmGlue(code, PUBLISHED_RUNTIME);

    // Then
    expect(rewritten).toContain('./wasm/testing/truapi_server.js');
    expect(rewritten).not.toContain('./wasm/web/truapi_server.js');
  });

  it('As a dotli developer, I leave every module but the marked runtime untouched', async () => {
    // Given
    const load = truapiSigningWorker().load as LoadHook;

    // When
    const plain = await load.call({}, PUBLISHED_RUNTIME);
    const marked = await load.call({}, `${PUBLISHED_RUNTIME}?truapi-signing&v=abc`);

    // Then
    expect(plain).toBeNull();
    expect(marked).toContain('./wasm/testing/truapi_server.js');
  });

  it('As a dotli developer, I resolve the marked id to the real published runtime file', () => {
    // Given
    const plugin = truapiSigningWorker();
    (plugin.configResolved as ConfigResolvedHook)({
      root: resolve(import.meta.dirname, '../../../apps/host'),
      build: { assetsDir: 'assets' },
    });

    // When
    const id = (plugin.resolveId as ResolveIdHook)(SIGNING_WORKER_RUNTIME_ID);

    // Then
    expect(id).toBe(`${PUBLISHED_RUNTIME}?truapi-signing`);
  });

  it('As a dotli developer, I fail loudly when the published package is not found', () => {
    // Given
    const plugin = truapiSigningWorker();
    (plugin.configResolved as ConfigResolvedHook)({ root: '/', build: { assetsDir: 'assets' } });

    // When
    const resolveId = (): string | null => (plugin.resolveId as ResolveIdHook)(SIGNING_WORKER_RUNTIME_ID);

    // Then
    expect(resolveId).toThrow(/was not found/);
  });

  it('As a dotli developer, I give the testing server wasm its own name and leave other worker assets as Vite names them', () => {
    // Given
    const asset = (originalFileName: string): Rolldown.PreRenderedAsset => ({
      type: 'asset',
      names: ['truapi_server_bg.wasm'],
      originalFileNames: [originalFileName],
      source: new Uint8Array(),
    });

    // When
    const testing = workerAssetFileName(asset(`${PACKAGE_DIST}/wasm/testing/truapi_server_bg.wasm`), 'assets');
    const web = workerAssetFileName(asset(`${PACKAGE_DIST}/wasm/web/truapi_server_bg.wasm`), 'assets');
    const verifiable = workerAssetFileName(asset(`${PACKAGE_DIST}/wasm/testing/truapi_verifiable_bg.wasm`), 'assets');

    // Then
    expect(testing).toBe('assets/truapi_signing_bg-[hash][extname]');
    expect(web).toBe('assets/[name]-[hash][extname]');
    expect(verifiable).toBe('assets/[name]-[hash][extname]');
  });
});
