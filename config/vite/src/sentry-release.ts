// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Sentry release name of a build, as semver.
//
// Sentry orders releases, and resolves "fixed in the next release", by
// version only when the name is `package@semver`. A commit hash gives it
// nothing to order by. The version comes from the newest `vX.Y.Z` tag the
// build descends from, because the tag is the release's source of truth: the
// package.json versions are synced to it only while a release deploys.
//
// A build of the tag itself is that release. Any later commit is a
// prerelease of the next patch, so it sorts after the tag it builds on and
// before whatever is released next, and its commit rides along as build
// metadata.

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
  // After a prerelease tag the next version is not known, so the commits
  // extend that prerelease instead, which still sorts before the next one.
  const version =
    pre === undefined
      ? `${base}.${String(Number(patch) + 1)}-dev.${String(ahead)}`
      : `${base}.${String(patch)}-${pre}.dev.${String(ahead)}`;
  return `${PACKAGE}@${version}+${String(hash)}`;
}

/**
 * Name this build's Sentry release in `VITE_SENTRY_RELEASE`, unless the
 * environment already did, so the runtime SDK and the sourcemap upload agree.
 * Left unset outside a git checkout with tags (a tarball, a shallow clone),
 * where the SDK falls back to the commit.
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
    // No git, or no tag reachable from HEAD: there is no version to name.
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
 * The `release` option for the Sentry sourcemap upload: the same name the SDK
 * reports, with its commits read from git, so Sentry can link a release to its
 * code and suspect commits. `ignoreMissing`, because the previous release may
 * be a name git has never heard of (the commit-named releases before these).
 */
export function sentryUploadRelease(
  cwd: string,
): { name: string; setCommits: { auto: true; ignoreMissing: true } } | Record<string, never> {
  const name = provideSentryRelease(cwd) ?? process.env['VITE_COMMIT_SHA'];
  return name === undefined || name === '' ? {} : { name, setCommits: { auto: true, ignoreMissing: true } };
}
