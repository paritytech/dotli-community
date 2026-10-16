// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes `host_version.json` so each origin's deploy can be checked with curl. At the bundle root, not /assets/,
// which nginx caches as immutable.

import type { Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readPackageVersion(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The newest `vX.Y.Z` tag the build descends from, since package.json versions sync to it only during a release.
 * Falls back to the package version without git or a tag.
 */
export function readReleaseVersion(dir: string): string {
  try {
    const tag = execSync("git describe --tags --abbrev=0 --match 'v[0-9]*'", {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return tag.slice(1);
  } catch {
    return readPackageVersion(dir);
  }
}

export function buildInfo(build: 'host' | 'app' | 'protocol'): Plugin {
  let root = '';
  return {
    name: 'dotli-build-info',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    // Post, so the hash covers every other plugin's output. public/ and the service workers are not covered.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const hash = createHash('sha256');
        const outputs = Object.entries(bundle).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (const [fileName, output] of outputs) {
          hash.update(`${fileName}\0`);
          hash.update(output.type === 'chunk' ? output.code : output.source);
          hash.update('\0');
        }
        const info = {
          build,
          version: readReleaseVersion(root),
          hash: hash.digest('hex'),
        };
        this.emitFile({
          type: 'asset',
          fileName: 'host_version.json',
          source: `${JSON.stringify(info)}\n`,
        });
      },
    },
  };
}
