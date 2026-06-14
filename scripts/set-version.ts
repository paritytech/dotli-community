#!/usr/bin/env bun
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sync every workspace package.json `version` field to a single version.
//
// The source of truth for a release is the git tag (e.g. `v0.6.1`). On
// release the Deploy workflow runs this script against the checked-out tag
// so the built artifacts always carry the release version and the package
// versions never drift apart from each other.
//
// Usage:
//   bun scripts/set-version.ts <version>      # e.g. 0.6.1 or v0.6.1
//   bun scripts/set-version.ts                # derive from $RELEASE_TAG / $GITHUB_REF_NAME / $GITHUB_REF
//   bun scripts/set-version.ts --check        # assert every package shares one version (CI guard)
//   bun scripts/set-version.ts --check <ver>  # assert every package is already at <ver>
//
// Packages are discovered from the root `workspaces` globs, so new packages
// are covered automatically. The root package.json is left untouched when it
// has no `version` field (it is private and intentionally version-less).
//
// Internal dependencies use the `workspace:*` protocol, so bumping a version
// never changes dependency resolution. The committed `bun.lock` does embed
// each workspace version, so after a local bump run `bun install` to refresh
// it; in CI this script runs *after* `bun install --frozen-lockfile`, so the
// frozen check has already passed and the ephemeral bump does not re-trigger
// install.
//
// Exit codes: 0 on success, 1 on a --check mismatch or any error.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// SemVer core with optional prerelease/build metadata, tolerant of a leading "v".
const SEMVER = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function normalizeVersion(raw: string): string {
  const match = SEMVER.exec(raw.trim());
  if (match === null) {
    throw new Error(`Not a valid semver version: "${raw}"`);
  }
  return match[1]; // strip any leading "v"
}

/** Resolve the target version from a CLI arg or CI env, or null if absent. */
function resolveTargetVersion(positional: string | undefined): string | null {
  const fromEnv =
    process.env.RELEASE_TAG ||
    process.env.GITHUB_REF_NAME ||
    (process.env.GITHUB_REF?.startsWith("refs/tags/")
      ? process.env.GITHUB_REF.slice("refs/tags/".length)
      : undefined);
  const raw = positional ?? fromEnv;
  return raw ? normalizeVersion(raw) : null;
}

/** Every workspace package.json (from the root `workspaces` globs) plus the root. */
function findPackageJsons(): string[] {
  const rootPkgPath = join(REPO_ROOT, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as {
    workspaces?: string[];
  };
  const out = [rootPkgPath];
  for (const glob of rootPkg.workspaces ?? []) {
    // The repo only uses the `dir/*` form; expand it one level deep.
    const base = glob.endsWith("/*") ? glob.slice(0, -2) : glob;
    const baseDir = join(REPO_ROOT, base);
    if (!existsSync(baseDir)) {
      continue;
    }
    for (const entry of readdirSync(baseDir)) {
      const pkgPath = join(baseDir, entry, "package.json");
      if (existsSync(pkgPath) && statSync(pkgPath).isFile()) {
        out.push(pkgPath);
      }
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const rel = (p: string): string => relative(REPO_ROOT, p) || "package.json";

interface PkgVersion {
  file: string;
  version: string;
  text: string;
}

/** Read every package.json that declares a `version`, skipping the rest. */
function readVersionedPackages(): PkgVersion[] {
  const result: PkgVersion[] = [];
  for (const file of findPackageJsons()) {
    const text = readFileSync(file, "utf8");
    const pkg = JSON.parse(text) as { version?: unknown };
    if (typeof pkg.version === "string") {
      result.push({ file, version: pkg.version, text });
    }
  }
  return result;
}

/** Replace only the package's own top-level `version` field, preserving formatting. */
function writeVersion(pkg: PkgVersion, target: string): void {
  const re = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(pkg.version)}(")`);
  const updated = pkg.text.replace(re, `$1${target}$2`);
  if (updated === pkg.text) {
    throw new Error(`Could not locate the version field in ${rel(pkg.file)}`);
  }
  writeFileSync(pkg.file, updated);
}

function runCheck(packages: PkgVersion[], target: string | null): void {
  // With no explicit target, "in sync" means every package shares one version.
  const reference = target ?? packages[0]?.version ?? null;
  if (reference === null) {
    console.error("No package.json with a version field found.");
    process.exit(1);
  }
  const mismatches = packages.filter((p) => p.version !== reference);
  for (const p of mismatches) {
    console.error(`✗ ${rel(p.file)}: ${p.version} (expected ${reference})`);
  }
  if (mismatches.length > 0) {
    console.error(
      `\n${mismatches.length} package(s) not at ${reference}. ` +
        `Run \`bun scripts/set-version.ts ${reference}\` to sync.`,
    );
    process.exit(1);
  }
  console.log(`All ${packages.length} package versions are ${reference}.`);
}

function runSet(packages: PkgVersion[], target: string): void {
  let changed = 0;
  for (const pkg of packages) {
    if (pkg.version === target) {
      continue;
    }
    writeVersion(pkg, target);
    console.log(`✓ ${rel(pkg.file)}: ${pkg.version} → ${target}`);
    changed++;
  }
  console.log(
    changed === 0
      ? `All ${packages.length} package(s) already at ${target}.`
      : `Set ${changed} of ${packages.length} package(s) to ${target}.`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const positional = args.find((a) => !a.startsWith("-"));
  const target = resolveTargetVersion(positional);
  const packages = readVersionedPackages();

  if (check) {
    runCheck(packages, target);
    return;
  }
  if (target === null) {
    throw new Error(
      "No version given. Pass one (e.g. `bun scripts/set-version.ts 0.6.1`) " +
        "or set RELEASE_TAG / GITHUB_REF_NAME.",
    );
  }
  runSet(packages, target);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
