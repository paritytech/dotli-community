// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';

/**
 * Sets `VITE_COMMIT_SHA` to the git HEAD of `cwd` unless already given, so local builds show a real commit too. Left
 * unset outside a git checkout. Never throws.
 */
export function provideCommitSha(cwd: string): void {
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
