// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AstroIntegration } from 'astro';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

/** Build before Workbox hashes the shell; never load ESM inside a service worker. */
export function receivingWorker(): AstroIntegration {
  let mode = 'production';
  return {
    name: 'dotli-receiving-worker',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [{
          name: 'dotli-receiving-mode',
          configResolved(config) { mode = config.mode; },
        }] } });
      },
      'astro:build:done': async ({ dir }) => {
        const root = resolve(import.meta.dirname, '../..');
        const env = loadEnv(mode, root, 'VITE_');
        const relayUrl = env['VITE_RECEIVING_RELAY_URL']?.trim() ?? '';
        const pushOrigin = env['VITE_RECEIVING_PUSH_ORIGIN']?.trim() ?? '';
        if (Boolean(relayUrl) !== Boolean(pushOrigin)) {
          throw new Error('Configure both VITE_RECEIVING_RELAY_URL and VITE_RECEIVING_PUSH_ORIGIN, or neither');
        }
        for (const [name, value] of [['relay URL', relayUrl], ['push origin', pushOrigin]] as const) {
          if (!value) continue;
          const url = new URL(value);
          if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
            throw new Error(`Receiving ${name} must be an HTTPS URL without credentials, query, or fragment`);
          }
          if (name === 'push origin' && value !== url.origin) {
            throw new Error('VITE_RECEIVING_PUSH_ORIGIN must be an origin, without a trailing slash or path');
          }
        }
        // Both JS and bytes resolve from the same installed, vendored PVM SDK.
        // Its generated glue must export the wallet-free WasmNotificationReceiver.
        const glue = fileURLToPath(import.meta.resolve('@parity/truapi-host/wasm/web'));
        const wasm = await readFile(resolve(dirname(glue), 'truapi_server_bg.wasm'));
        const wasmName = `assets/receiving-${createHash('sha256').update(wasm).digest('hex').slice(0, 20)}.wasm`;
        const output = fileURLToPath(dir);
        await mkdir(resolve(output, 'assets'), { recursive: true });
        const result = await build({
          absWorkingDir: import.meta.dirname,
          entryPoints: ['src/receiving-worker.ts'],
          bundle: true,
          format: 'iife',
          platform: 'browser',
          target: 'es2022',
          minify: true,
          write: false,
          metafile: true,
          define: {
            __RECEIVING_RELAY_URL__: JSON.stringify(relayUrl),
            __RECEIVING_PUSH_ORIGIN__: JSON.stringify(pushOrigin),
            __RECEIVING_WASM_URL__: JSON.stringify(`/${wasmName}`),
            // wasm-bindgen's unused default URL also has to be classic-script
            // safe. Initialization above always supplies the content-hashed URL.
            'import.meta.url': 'self.location.href',
          },
        });
        if (Object.values(result.metafile.outputs).some(file => file.imports.length !== 0)) {
          throw new Error('Receiving service worker must be standalone: external/dynamic imports are forbidden');
        }
        const script = result.outputFiles[0];
        if (!script) throw new Error('Receiving service worker bundle was not emitted');
        await writeFile(resolve(output, wasmName), wasm);
        await writeFile(resolve(output, 'host-receiving.js'), script.contents);
        // Exact-origin policy for installations enforcing CSP at the edge.
        // This is an nginx include, not product-readable runtime configuration.
        const relayOrigin = relayUrl ? ` ${new URL(relayUrl).origin}` : '';
        await writeFile(resolve(output, 'host-receiving-csp.conf'),
          `add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'${relayOrigin}" always;\n`);
      },
    },
  };
}
