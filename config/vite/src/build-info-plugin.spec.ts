// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo, readReleaseVersion } from './build-info-plugin.js';

type Output = { type: 'chunk'; code: string } | { type: 'asset'; source: string | Uint8Array };

function emit(root: string, bundle: Record<string, Output>): unknown {
  const plugin = buildInfo('host');
  const emitted: { fileName?: string; source?: unknown }[] = [];
  (plugin.configResolved as (config: { root: string }) => void)({ root });
  const hook = plugin.generateBundle as {
    handler: (this: unknown, options: unknown, bundle: unknown) => void;
  };
  hook.handler.call(
    {
      emitFile: (file: { fileName?: string; source?: unknown }) => {
        emitted.push(file);
        return '';
      },
    },
    {},
    bundle,
  );
  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.fileName).toBe('host_version.json');
  return JSON.parse(emitted[0]?.source as string);
}

const BUNDLE: Record<string, Output> = {
  'index.html': { type: 'asset', source: '<html></html>' },
  'assets/index-abc.js': { type: 'chunk', code: 'console.log(1)' },
  'icon.png': { type: 'asset', source: new Uint8Array([1, 2, 3]) },
};

describe('buildInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dotli-build-info-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('As a build outside a git checkout, I report the build, the package version and a content hash', () => {
    // Given
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');

    // When / Then
    expect(emit(dir, BUNDLE)).toEqual({
      build: 'host',
      version: '1.2.3',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
  });

  it('As a build with no package.json, I report version 0.0.0', () => {
    // When / Then
    expect(emit(dir, BUNDLE)).toMatchObject({ version: '0.0.0' });
  });

  it('As a maintainer, I build the same files in another order and get the same content hash, and other files change it', () => {
    // Given
    const hashOf = (bundle: Record<string, Output>): string => (emit(dir, bundle) as { hash: string }).hash;
    const reordered = Object.fromEntries(Object.entries(BUNDLE).reverse());

    // When / Then
    expect(hashOf(reordered)).toBe(hashOf(BUNDLE));
    expect(
      hashOf({
        ...BUNDLE,
        'assets/index-abc.js': { type: 'chunk', code: 'console.log(2)' },
      }),
    ).not.toBe(hashOf(BUNDLE));
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
    const git = (args: string): void => {
      execSync(
        `git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c tag.gpgsign=false ${args}`,
        { cwd: dir, stdio: 'ignore' },
      );
    };
    git('add -A');
    git('commit --allow-empty -m commit');
    if (tag !== undefined) {
      git(`tag ${tag}`);
    }
  }

  it('As a release build, I report the newest release tag my commit descends from, not the stale package version', () => {
    // Given
    execSync('git init -q', { cwd: dir });
    commit('v0.10.1');
    commit();

    // When
    const version = readReleaseVersion(dir);

    // Then
    expect(version).toBe('0.10.1');
  });

  it('As a build outside a git checkout, I fall back to the package version', () => {
    // When
    const version = readReleaseVersion(dir);

    // Then
    expect(version).toBe('0.6.0');
  });
});
