// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every app's build shares: where it is served, where `.env` lives, the wasm plugin and the Sentry upload. Making
// it fills in the commit and the Sentry release, so call it before Vite reads the environment.

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import type { Plugin, PluginOption } from 'vite';
import wasmPlugin from 'vite-plugin-wasm';
import { provideSentryRelease, sentryUploadRelease } from './sentry-release.ts';

// Its CommonJS-style declarations make NodeNext see the module object, but at runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

export interface DotliApp {
  /** The path the app is served under, from `VITE_APP_URL`. */
  base: string;
  /** The repo root, where `.env` lives. */
  envDir: string;
  wasm: () => Plugin;
  /** Uploads source maps when metrics are on and a token is set. Otherwise nothing, so local builds keep them. */
  sentry: () => PluginOption;
}

/** Falls back to git HEAD so local builds show a real commit too. Left unset, it reads as "dev". */
function provideCommitSha(cwd: string): void {
  if ((process.env['VITE_COMMIT_SHA'] ?? '') !== '') {
    return;
  }
  try {
    process.env['VITE_COMMIT_SHA'] = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    // eslint-disable-next-line no-restricted-syntax -- no git checkout is a normal build, not an error.
  } catch {
    // Not a git checkout.
  }
}

/** The shared build settings of the app in `appDir`. */
export function dotliApp(appDir: string): DotliApp {
  provideCommitSha(appDir);
  provideSentryRelease(appDir);
  const appUrl = process.env['VITE_APP_URL'] ?? '';
  return {
    base: appUrl === '' ? '/' : new URL(appUrl).pathname,
    envDir: resolve(appDir, '../..'),
    wasm,
    sentry: () => {
      if (process.env['VITE_METRICS'] !== 'true' || (process.env['SENTRY_AUTH_TOKEN'] ?? '') === '') {
        return false;
      }
      return sentryVitePlugin({
        org: 'paritytech',
        project: 'dotli',
        telemetry: false,
        authToken: process.env['SENTRY_AUTH_TOKEN'],
        release: sentryUploadRelease(appDir),
        sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
      });
    },
  };
}
