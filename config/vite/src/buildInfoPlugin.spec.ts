// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo, readReleaseVersion } from './buildInfoPlugin.js';
import { BUILD_INFO_FILE } from './siteRoutes.js';

type Output = { type: 'chunk'; code: string } | { type: 'asset'; source: string | Uint8Array };

/** The build info file's contents. */
type BuildInfo = {
  /** The build the plugin was made for. */
  build: string;
  /** The release version. */
  version: string;
  /** The hex SHA-256 of the bundle's files and their names. */
  hash: string;
};

const BUNDLE: Record<string, Output> = {
  'index.html': { type: 'asset', source: '<html></html>' },
  'assets/index-abc.js': { type: 'chunk', code: 'console.log(1)' },
  'icon.png': { type: 'asset', source: new Uint8Array([1, 2, 3]) },
};

/** Runs the plugin's hooks over `bundle` from `root`. Throws unless it emits exactly the build info file. */
function emitBuildInfo(root: string, bundle: Record<string, Output>): BuildInfo {
  const plugin = buildInfo('host');
  const emitted: { fileName?: string; source?: unknown }[] = [];
  // The plugin defines the hook as a plain function, which Vite types as a function-or-object hook.
  (plugin.configResolved as (config: { root: string }) => void)({ root });
  // The plugin defines the hook in its object form, which Vite types as a function-or-object hook.
  const hook = plugin.generateBundle as {
    handler: (this: unknown, options: unknown, bundle: unknown) => void;
  };
  hook.handler.call(
    {
      emitFile(file: { fileName?: string; source?: unknown }) {
        emitted.push(file);
        return '';
      },
    },
    {},
    bundle,
  );
  const [file, ...others] = emitted;
  if (file?.fileName !== BUILD_INFO_FILE || typeof file.source !== 'string' || others.length > 0) {
    throw new Error(
      `expected only ${BUILD_INFO_FILE}, got ${emitted.map(({ fileName }) => String(fileName)).join(', ')}`,
    );
  }
  // The plugin writes this shape, which the cases below check field by field.
  return JSON.parse(file.source) as BuildInfo;
}

describe('buildInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dotli-build-info-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('As a maintainer, I build outside a git checkout and the build info reports the build, the package version and a content hash', () => {
    // Given
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');

    // When
    const info = emitBuildInfo(dir, BUNDLE);

    // Then
    expect(BUILD_INFO_FILE).toBe('host_version.json');
    expect(info).toEqual({
      build: 'host',
      version: '1.2.3',
      // The matcher is typed `any`, which the lint bans in an object literal.
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
  });

  it('As a dotli developer, I build a folder with no package.json and the build info reports version 0.0.0', () => {
    // Given an empty folder with no package.json

    // When
    const info = emitBuildInfo(dir, BUNDLE);

    // Then
    expect(info.version).toBe('0.0.0');
  });

  it('As a maintainer, I build the same files in another order and get the same content hash, and other files change it', () => {
    // Given
    const reordered = Object.fromEntries(Object.entries(BUNDLE).reverse());
    const changed: Record<string, Output> = {
      ...BUNDLE,
      'assets/index-abc.js': { type: 'chunk', code: 'console.log(2)' },
    };

    // When
    const [original, reorderedHash, changedHash] = [BUNDLE, reordered, changed].map(
      bundle => emitBuildInfo(dir, bundle).hash,
    );

    // Then
    expect(reorderedHash).toBe(original);
    expect(changedHash).not.toBe(original);
  });
});

describe('readReleaseVersion', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dotli-release-version-'));
    writeFileSync(join(dir, 'package.json'), '{"version":"0.6.0"}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commit(tag?: string): void {
    git('add -A');
    git('commit --allow-empty -m commit');
    if (tag !== undefined) {
      git(`tag ${tag}`);
    }

    function git(args: string): void {
      execSync(
        `git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c tag.gpgsign=false ${args}`,
        { cwd: dir, stdio: 'ignore' },
      );
    }
  }

  it('As a maintainer, I build a commit after a release tag and get that tag as the version, not the stale package version', () => {
    // Given
    execSync('git init -q', { cwd: dir });
    commit('v0.10.1');
    commit();

    // When
    const version = readReleaseVersion(dir);

    // Then
    expect(version).toBe('0.10.1');
  });

  it('As a maintainer, I build outside a git checkout and get the package version', () => {
    // Given a folder with a package.json and no git repository

    // When
    const version = readReleaseVersion(dir);

    // Then
    expect(version).toBe('0.6.0');
  });
});
