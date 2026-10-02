// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS-modules options shared by the host, the sandbox and the ui tests.
 *
 * Class names are scoped to their module: `Spinner_spinner_ab12` in dev, so a
 * name in devtools points at its file, and a six-character hash in
 * production. The hash covers the module's path relative to the repository,
 * so builds on different machines name classes the same way.
 */

import { createHash } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import type { CSSModulesOptions } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** The scoped name of class `local` in the module at `file`. */
export function scopedClassName(local: string, file: string, production: boolean): string {
  const path = file.replace(/\?.*$/, '');
  const hash = createHash('sha256')
    .update(`${relative(REPO_ROOT, path)}:${local}`)
    .digest('base64url');
  if (production) {
    return `_${hash.slice(0, 6)}`;
  }
  return `${basename(path).replace(/\.module\.css$/, '')}_${local}_${hash.slice(0, 4)}`;
}

/** `css.modules` for a Vite or Astro config. Production naming follows NODE_ENV at transform time. */
export function cssModules(): CSSModulesOptions {
  return {
    localsConvention: 'camelCaseOnly',
    generateScopedName: (local, file) => scopedClassName(local, file, process.env['NODE_ENV'] === 'production'),
  };
}
