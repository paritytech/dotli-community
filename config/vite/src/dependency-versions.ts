// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The versions the diagnostics panel lists: dot.li's direct dependencies only, since transitive ones would balloon the
// list, each at the version Node resolves for the workspace that depends on it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PackageVersion {
  name: string;
  version: string;
}

const WORKSPACE_ROOTS = ['apps', 'packages'];

function installedVersion(name: string, from: URL): string | undefined {
  let manifest: string | undefined;
  try {
    manifest = findPackageJSON(name, from);
  } catch (err) {
    // Not installed, as in a partial checkout, so the panel leaves it out.
    if ((err as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND') {
      return undefined;
    }
    throw new Error(`Could not resolve ${name} from ${from.href}`, { cause: err });
  }
  if (manifest === undefined) {
    return undefined;
  }
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
  return version === undefined || version === '' ? undefined : version;
}

/** Each direct dependency of a workspace under `repoRoot` whose name starts with one of `prefixes`, sorted by name. */
export function dependencyVersions(repoRoot: string, prefixes: readonly string[]): PackageVersion[] {
  const versions = new Map<string, string>();
  for (const workspaces of WORKSPACE_ROOTS) {
    const dir = join(repoRoot, workspaces);
    if (!existsSync(dir)) {
      continue;
    }
    for (const workspace of readdirSync(dir)) {
      const manifest = join(dir, workspace, 'package.json');
      if (!existsSync(manifest)) {
        continue;
      }
      const { dependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      for (const name of Object.keys(dependencies)) {
        if (versions.has(name) || !prefixes.some(prefix => name.startsWith(prefix))) {
          continue;
        }
        const version = installedVersion(name, pathToFileURL(manifest));
        if (version !== undefined) {
          versions.set(name, version);
        }
      }
    }
  }
  return [...versions].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
}
