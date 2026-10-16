// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sentry orders releases only when the name is `package@semver`. A build of a tag is that release. A later commit
// is a prerelease of the next patch, so it sorts between the two, with its commit as build metadata.

import { execSync } from 'node:child_process';

const PACKAGE = 'dotli';

// `git describe --long` output: tag, commits since it, abbreviated hash.
const DESCRIBE = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?-(\d+)-g([0-9a-f]+)$/;

/** The release name for a `git describe --tags --long` result, or null if it names no semver tag. */
export function releaseFromDescribe(describe: string): string | null {
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

/**
 * Sets `VITE_SENTRY_RELEASE` unless already given, so the SDK and the sourcemap upload agree.
 * Left unset without git tags, where the SDK falls back to the commit.
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
  const release = releaseFromDescribe(describe);
  if (release === null) {
    return undefined;
  }
  process.env['VITE_SENTRY_RELEASE'] = release;
  return release;
}

/**
 * The sourcemap upload's `release`, with commits read from git for suspect commits.
 * `ignoreMissing` because the previous release may be a commit-named one git does not know.
 */
export function sentryUploadRelease(
  cwd: string,
): { name: string; setCommits: { auto: true; ignoreMissing: true } } | Record<string, never> {
  const name = provideSentryRelease(cwd) ?? process.env['VITE_COMMIT_SHA'];
  return name === undefined || name === '' ? {} : { name, setCommits: { auto: true, ignoreMissing: true } };
}
