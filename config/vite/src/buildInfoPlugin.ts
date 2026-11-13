// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes `host_version.json` so each origin's deploy can be checked with curl. At the bundle root, since a file under
// /assets/ is cached as immutable.

import type { Plugin, Rolldown } from 'vite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_INFO_FILE, type Site } from './siteRoutes.ts';

/** Returns the plugin that writes the build's name, release version and output hash at the bundle root. */
export function buildInfo(build: Site): Plugin {
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
        // By UTF-16 code units, the same on every machine, unlike a locale compare. Bundle names are unique.
        const outputs = Object.entries(bundle).sort(([a], [b]) => (a < b ? -1 : 1));
        for (const [fileName, output] of outputs) {
          hash.update(`${fileName}\0`);
          hash.update(readOutputContent(output));
          hash.update('\0');
        }
        const info = {
          build,
          version: readReleaseVersion(root),
          hash: hash.digest('hex'),
        };
        this.emitFile({
          type: 'asset',
          fileName: BUILD_INFO_FILE,
          source: `${JSON.stringify(info)}\n`,
        });
      },
    },
  };
}

/**
 * Returns the newest `vX.Y.Z` tag the build in `dir` descends from, without its `v`, since package.json versions sync
 * to it only during a release. Falls back to the package version without git or a tag, and to `0.0.0` without either.
 * Never throws.
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
    // No git, or no tag reachable from HEAD, reads the package version instead.
    return readPackageVersion(dir);
  }
}

function readPackageVersion(dir: string): string {
  try {
    // A package.json this repo writes, so its shape is known.
    const packageJson = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    // A missing or unreadable package.json reads as no version.
    return '0.0.0';
  }
}

function readOutputContent(output: Rolldown.OutputChunk | Rolldown.OutputAsset): string | Uint8Array {
  switch (output.type) {
    case 'chunk':
      return output.code;
    case 'asset':
      return output.source;
  }
}
