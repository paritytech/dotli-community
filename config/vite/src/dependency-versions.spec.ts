// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dependencyVersions } from './dependency-versions.js';

let root = '';

function write(path: string, json: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(json));
}

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('dependencyVersions', () => {
  it('As the diagnostics panel, I get the installed version of each direct dependency in a scope, once and sorted', () => {
    // Given two workspaces sharing a hoisted dependency, one with its own nested copy of another
    root = mkdtempSync(join(tmpdir(), 'dotli-versions-'));
    write('apps/host/package.json', { dependencies: { '@scope/b': '^2', other: '^1' } });
    write('packages/chains/package.json', {
      dependencies: { '@scope/a': '^1', '@scope/b': '^2' },
      devDependencies: { '@scope/dev': '^1' },
    });
    write('node_modules/@scope/a/package.json', { name: '@scope/a', version: '1.2.3' });
    write('packages/chains/node_modules/@scope/a/package.json', { name: '@scope/a', version: '1.9.0' });
    write('node_modules/@scope/b/package.json', { name: '@scope/b', version: '2.0.0' });
    write('node_modules/@scope/dev/package.json', { name: '@scope/dev', version: '9.9.9' });
    write('node_modules/other/package.json', { name: 'other', version: '1.0.0' });

    // When
    const versions = dependencyVersions(root, ['@scope/']);

    // Then
    expect(versions).toEqual([
      { name: '@scope/a', version: '1.9.0' },
      { name: '@scope/b', version: '2.0.0' },
    ]);
  });

  it('As the diagnostics panel, a dependency that is not installed is left out rather than failing the build', () => {
    // Given
    root = mkdtempSync(join(tmpdir(), 'dotli-versions-'));
    write('packages/chains/package.json', { dependencies: { '@scope/missing': '^1' } });

    // When
    const versions = dependencyVersions(root, ['@scope/']);

    // Then
    expect(versions).toEqual([]);
  });
});
