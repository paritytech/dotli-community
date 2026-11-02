// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The installed versions of dot.li's direct dependencies only, since transitive ones would balloon the list, each at the
// version Node resolves for the workspace that depends on it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type PackageVersion = {
  /** The package's name. */
  name: string;
  /** Its installed version. */
  version: string;
};

const WORKSPACE_ROOTS = ['apps', 'packages'];

/**
 * Returns each direct dependency of a workspace under `repoRoot` whose name starts with one of `prefixes`, at its
 * installed version, sorted by name. One that is not installed is left out. Throws when a dependency cannot be
 * resolved for another reason.
 */
export function listDependencyVersions(repoRoot: string, prefixes: readonly string[]): PackageVersion[] {
  const versions = new Map<string, string>();
  for (const manifest of listWorkspaceManifests(repoRoot)) {
    // A workspace's package.json, whose shape this repo writes.
    const { dependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(dependencies)) {
      if (versions.has(name) || !prefixes.some(prefix => name.startsWith(prefix))) {
        continue;
      }
      const version = readInstalledVersion(name, pathToFileURL(manifest));
      if (version === undefined) {
        continue;
      }
      versions.set(name, version);
    }
  }
  return [...versions].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
}

function listWorkspaceManifests(repoRoot: string): string[] {
  const manifests: string[] = [];
  for (const workspaces of WORKSPACE_ROOTS) {
    const dir = join(repoRoot, workspaces);
    if (!existsSync(dir)) {
      continue;
    }
    const candidates = readdirSync(dir).map(workspace => join(dir, workspace, 'package.json'));
    manifests.push(...candidates.filter(manifest => existsSync(manifest)));
  }
  return manifests;
}

function readInstalledVersion(name: string, from: URL): string | undefined {
  let manifest: string | undefined;
  try {
    manifest = findPackageJSON(name, from);
  } catch (error) {
    // Not installed, as in a partial checkout, so the list leaves it out.
    if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      return undefined;
    }
    throw new Error(`Could not resolve ${name} from ${from.href}`, { cause: error });
  }
  if (manifest === undefined) {
    return undefined;
  }
  // An installed package's package.json, where npm guarantees an object.
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
  return version === undefined || version === '' ? undefined : version;
}
