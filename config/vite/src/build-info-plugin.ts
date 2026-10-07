// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin: write the build name, release version and a hash of the
// bundle's contents to `host_version.json` at the bundle root, so each origin's
// deploy can be checked with curl. The root, not /assets/, which nginx caches
// as immutable.

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
 * dotli's version: the newest `vX.Y.Z` tag the build descends from. The tag
 * is the release's source of truth, as the package.json versions are synced
 * to it only while a release deploys. Without git or a tag (a tarball, a
 * shallow clone) it falls back to the package version in `dir`.
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
    // Post, so every other plugin has emitted into the bundle and the hash
    // covers the final bytes. Files outside the bundle are not part of it: the
    // copied public/ dir and the service workers, written after it.
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
