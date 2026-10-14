// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AstroIntegration } from 'astro';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Emit the classic import before Workbox generates the host service worker. */
export function notificationWorker(): AstroIntegration {
  return {
    name: 'dotli-notification-worker',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const result = await build({
          absWorkingDir: import.meta.dirname,
          entryPoints: ['src/notification-worker.ts'],
          bundle: true,
          format: 'iife',
          platform: 'browser',
          target: 'es2022',
          minify: true,
          write: false,
          metafile: true,
        });
        if (Object.values(result.metafile.outputs).some(file => file.imports.length !== 0)) {
          throw new Error('Notification service worker must not contain external or dynamic imports');
        }
        const script = result.outputFiles[0];
        if (!script) {
          throw new Error('Notification service worker bundle was not emitted');
        }
        await writeFile(resolve(fileURLToPath(dir), 'host-notifications.js'), script.contents);
      },
    },
  };
}
