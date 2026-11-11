// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { compare, listEagerPages, measureApp, stripHash, sumByName, type Size } from './bundleSizes.ts';

function createSize(raw: number): Size {
  return { raw, br: raw / 2, gz: raw / 2 };
}

/** Returns a new empty build folder, removed when the test `context` ends. */
function createDist(context: TestContext): string {
  const dist = mkdtempSync(join(tmpdir(), 'bundle-sizes-'));
  context.after(() => {
    rmSync(dist, { recursive: true, force: true });
  });
  return dist;
}

describe('stripHash', () => {
  it('As a reviewer reading the bundle size report, I read hashed file names and see each without the 8-character content hash after a dot or a dash', () => {
    // Given a hash after a dash, one after a dot, an unhashed name, and a name outside assets ending in an 8-letter word
    const hashed = [
      'host/assets/fetch-CMRV9u5T.js',
      'host/assets/client.BIMa48MH.js',
      'host/index.html',
      'host/icons/icon-portrait.png',
    ];

    // When
    const names = hashed.map(name => stripHash(name));

    // Then
    assert.deepEqual(names, [
      'host/assets/fetch.js',
      'host/assets/client.js',
      'host/index.html',
      'host/icons/icon-portrait.png',
    ]);
  });
});

describe('sumByName', () => {
  it('As a reviewer reading the bundle size report, I read files that share a name once their hashes are gone and see them added up', () => {
    // Given two files that share a name and one that does not
    const files = [
      { name: 'host/assets/client.js', ...createSize(100) },
      { name: 'host/assets/index.js', ...createSize(40) },
      { name: 'host/assets/client.js', ...createSize(60) },
    ];

    // When
    const sums = sumByName(files);

    // Then
    assert.deepEqual(
      [...sums],
      [
        ['host/assets/client.js', { count: 2, raw: 160, br: 80, gz: 80 }],
        ['host/assets/index.js', { count: 1, raw: 40, br: 20, gz: 20 }],
      ],
    );
  });
});

describe('compare', () => {
  const current = sumByName([
    { name: 'host/a.js', ...createSize(100) },
    { name: 'host/new.js', ...createSize(50) },
  ]);

  it('As a reviewer reading the bundle size report, I see the base total of the whole baseline, so a removed file and an added one both show', () => {
    // Given a baseline with a file the build removed and an eager path entry
    const baseline = {
      'host/a.js': createSize(100),
      'host/gone.js': createSize(30),
      'host/(eager path)': createSize(70),
    };

    // When
    const { total, baseTotal } = compare(current, baseline);

    // Then
    assert.deepEqual(total, createSize(150));
    // a.js and gone.js. The eager path is a subset of the files, not a file.
    assert.deepEqual(baseTotal, createSize(130));
  });

  it('As a reviewer reading the bundle size report, I compare against a baseline and see each file next to its baseline entry, or none for a file main does not have', () => {
    // Given a baseline that lacks the build's new file
    const baseline = { 'host/a.js': createSize(90) };

    // When
    const { files } = compare(current, baseline);

    // Then
    assert.deepEqual(
      files.map(({ name, base }) => [name, base]),
      [
        ['host/a.js', createSize(90)],
        ['host/new.js', null],
      ],
    );
  });

  it('As a reviewer reading the bundle size report, I compare with no baseline and see no base total', () => {
    // Given no baseline, either missing or empty

    // When
    const baseTotals = [compare(current, null).baseTotal, compare(current, {}).baseTotal];

    // Then
    assert.deepEqual(baseTotals, [null, null]);
  });
});

describe('measureApp', () => {
  it('As a reviewer reading the bundle size report, I see each emitted file sized by its precompressed siblings, and no source maps', context => {
    // Given
    const dist = createDist(context);
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), 'x'.repeat(10));
    writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js'), 'x'.repeat(100));
    writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js.br'), 'x'.repeat(30));
    writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js.gz'), 'x'.repeat(40));
    writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js.map'), 'x'.repeat(500));

    // When
    const sizes = measureApp('host', dist);

    // Then
    assert.deepEqual(sizes, [
      { name: 'host/assets/app.js', raw: 100, br: 30, gz: 40 },
      { name: 'host/index.html', raw: 10, br: 10, gz: 10 },
    ]);
  });
});

describe('listEagerPages', () => {
  it("As a reviewer reading the bundle size report, I list a build's pages and see the eager path of each root page, the index page under the app's own name", context => {
    // Given
    const dist = createDist(context);
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '');
    writeFileSync(join(dist, 'landing.html'), '');
    writeFileSync(join(dist, 'assets', 'nested.html'), '');
    writeFileSync(join(dist, 'manifest.webmanifest'), '');

    // When
    const pages = listEagerPages('host', dist);

    // Then
    assert.deepEqual(pages, [
      { name: 'host/(eager path)', page: 'index.html' },
      { name: 'host/landing/(eager path)', page: 'landing.html' },
    ]);
  });
});
