// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Syncs every workspace package.json `version` to the release tag, so built artifacts carry the release version.
//   node scripts/setVersion.ts [<version>]          # default from $RELEASE_TAG, $GITHUB_REF_NAME or $GITHUB_REF
//   node scripts/setVersion.ts --check [<version>]  # every package at <version>, or sharing one
// The lockfile embeds workspace versions, so run `npm install` after a local bump.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageVersion = {
  file: string;
  version: string;
  text: string;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Tolerates a leading "v".
const SEMVER = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const positional = args.find(a => !a.startsWith('-'));
  const target = resolveTargetVersion(positional);
  const packages = readVersionedPackages();

  if (check) {
    runCheck(packages, target);
    return;
  }
  if (target === null) {
    throw new Error(
      'No version given. Pass one (e.g. `node scripts/setVersion.ts 0.6.1`) or set RELEASE_TAG / GITHUB_REF_NAME.',
    );
  }
  runSet(packages, target);
}

function normalizeVersion(raw: string): string {
  const version = SEMVER.exec(raw.trim())?.[1];
  if (version === undefined) {
    throw new Error(`Not a valid semver version: "${raw}"`);
  }
  return version;
}

/** Resolve the target version from a CLI arg or CI env, or null if absent. */
function resolveTargetVersion(positional: string | undefined): string | null {
  // An empty variable counts as unset, as CI can export one without a value.
  const set = (value: string | undefined): string | undefined => (value === '' ? undefined : value);
  const ref = process.env['GITHUB_REF'];
  const fromEnv =
    set(process.env['RELEASE_TAG']) ??
    set(process.env['GITHUB_REF_NAME']) ??
    (ref?.startsWith('refs/tags/') === true ? ref.slice('refs/tags/'.length) : undefined);
  const raw = positional ?? fromEnv;
  return raw === undefined || raw === '' ? null : normalizeVersion(raw);
}

/** Every workspace package.json (from the root `workspaces` globs) plus the root. */
function findPackageJsons(): string[] {
  const rootPackagePath = join(REPO_ROOT, 'package.json');
  // The repo's own root package.json, whose `workspaces` is a list of globs.
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8')) as {
    workspaces?: string[];
  };
  const paths = [rootPackagePath];
  for (const glob of rootPackage.workspaces ?? []) {
    // The repo only uses the `dir/*` form.
    const base = glob.endsWith('/*') ? glob.slice(0, -2) : glob;
    const baseDir = join(REPO_ROOT, base);
    if (!existsSync(baseDir)) {
      continue;
    }
    for (const entry of readdirSync(baseDir)) {
      const packagePath = join(baseDir, entry, 'package.json');
      if (!existsSync(packagePath) || !statSync(packagePath).isFile()) {
        continue;
      }
      paths.push(packagePath);
    }
  }
  return paths;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRelativePath(path: string): string {
  return relative(REPO_ROOT, path) || 'package.json';
}

function readVersionedPackages(): PackageVersion[] {
  const result: PackageVersion[] = [];
  for (const file of findPackageJsons()) {
    const text = readFileSync(file, 'utf8');
    // A package.json is an object, and the check below reads only `version`.
    const packageJson = JSON.parse(text) as { version?: unknown };
    if (typeof packageJson.version === 'string') {
      result.push({ file, version: packageJson.version, text });
    }
  }
  return result;
}

/** Rewrites only the top-level `version` field, preserving formatting. */
function writeVersion(packageVersion: PackageVersion, target: string): void {
  const pattern = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(packageVersion.version)}(")`);
  const updated = packageVersion.text.replace(pattern, `$1${target}$2`);
  if (updated === packageVersion.text) {
    throw new Error(`Could not locate the version field in ${toRelativePath(packageVersion.file)}`);
  }
  writeFileSync(packageVersion.file, updated);
}

function runCheck(packages: PackageVersion[], target: string | null): void {
  // With no explicit target, "in sync" means every package shares one version.
  const reference = target ?? packages[0]?.version ?? null;
  if (reference === null) {
    console.error(`No package.json with a version field found under ${REPO_ROOT}.`);
    process.exit(1);
  }
  const mismatches = packages.filter(entry => entry.version !== reference);
  for (const mismatch of mismatches) {
    console.error(`✗ ${toRelativePath(mismatch.file)}: ${mismatch.version} (expected ${reference})`);
  }
  if (mismatches.length > 0) {
    console.error(
      `\n${String(mismatches.length)} package(s) not at ${reference}. ` +
        `Run \`node scripts/setVersion.ts ${reference}\` to sync.`,
    );
    process.exit(1);
  }
  console.log(`All ${String(packages.length)} package versions are ${reference}.`);
}

function runSet(packages: PackageVersion[], target: string): void {
  let changed = 0;
  for (const packageVersion of packages) {
    if (packageVersion.version === target) {
      continue;
    }
    writeVersion(packageVersion, target);
    console.log(`✓ ${toRelativePath(packageVersion.file)}: ${packageVersion.version} to ${target}`);
    changed++;
  }
  console.log(
    changed === 0
      ? `All ${String(packages.length)} package(s) already at ${target}.`
      : `Set ${String(changed)} of ${String(packages.length)} package(s) to ${target}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
