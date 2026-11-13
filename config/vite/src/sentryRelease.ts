// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sentry orders releases only when the name is `package@semver`. A build of a tag is that release. A later commit
// is a prerelease of the next patch, so it sorts between the two, with its commit as build metadata.

import { execSync } from 'node:child_process';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { loadEnv, type PluginOption } from 'vite';

const PACKAGE = 'dotli';

// `git describe --long` output: tag, commits since it, abbreviated hash.
const DESCRIBE = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?-(\d+)-g([0-9a-f]+)$/;

/**
 * Sets `VITE_SENTRY_RELEASE` unless already given, so the SDK and the sourcemap upload agree, and returns it. Never
 * throws. Left unset without git tags, and then returns `undefined`.
 */
export function provideSentryRelease(cwd: string): string | undefined {
  const given = process.env['VITE_SENTRY_RELEASE'];
  if (given !== undefined && given !== '') {
    return given;
  }
  let describe: string;
  try {
    describe = execSync("git describe --tags --long --abbrev=7 --match 'v[0-9]*'", {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    // No git, or no tag reachable from HEAD.
    return undefined;
  }
  const release = parseReleaseName(describe);
  if (release === null) {
    return undefined;
  }
  process.env['VITE_SENTRY_RELEASE'] = release;
  return release;
}

/**
 * Returns the plugin that uploads the source maps under `release` when metrics are on and a token is set, and `false`
 * otherwise, so local builds keep them. Never throws.
 */
export function createSentryUpload(release: string | undefined, envDir: string): PluginOption {
  if ((process.env['SENTRY_AUTH_TOKEN'] ?? '') === '') {
    return false;
  }
  const plugins = [
    sentryVitePlugin({
      org: 'paritytech',
      project: 'dotli',
      telemetry: false,
      authToken: process.env['SENTRY_AUTH_TOKEN'],
      // `ignoreMissing` because the previous release may be a commit-named one git does not know.
      release:
        release === undefined || release === ''
          ? {}
          : { name: release, setCommits: { auto: true, ignoreMissing: true } },
      sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
    }),
  ].flat();
  // Decided per build, from the `.env` files and process env of the build's mode.
  return plugins.map(plugin => ({
    ...plugin,
    apply: (_config, { mode }) => loadEnv(mode, envDir, 'VITE_')['VITE_METRICS'] === 'true',
  }));
}

/** Returns the release name for a `git describe --tags --long` result, or null if it names no semver tag. */
export function parseReleaseName(describe: string): string | null {
  const match = DESCRIBE.exec(describe.trim());
  if (match === null) {
    return null;
  }
  const [, major, minor, patch, pre, ahead, hash] = match;
  const base = `${String(major)}.${String(minor)}`;
  if (ahead === '0') {
    return `${PACKAGE}@${base}.${String(patch)}${pre === undefined ? '' : `-${pre}`}`;
  }
  // After a prerelease tag the next version is unknown, so the commits extend that prerelease.
  const version =
    pre === undefined
      ? `${base}.${String(Number(patch) + 1)}-dev.${String(ahead)}`
      : `${base}.${String(patch)}-${pre}.dev.${String(ahead)}`;
  return `${PACKAGE}@${version}+${String(hash)}`;
}
