// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compare, measureApp, stripHash, sumByName } from './bundle-sizes.ts';

const size = (raw: number): { raw: number; br: number; gz: number } => ({ raw, br: raw / 2, gz: raw / 2 });

describe('stripHash', () => {
  it('drops an 8-character content hash after a dot or a dash', () => {
    assert.equal(stripHash('host/assets/fetch-CMRV9u5T.js'), 'host/assets/fetch.js');
    assert.equal(stripHash('host/assets/client.BIMa48MH.js'), 'host/assets/client.js');
    assert.equal(stripHash('host/index.html'), 'host/index.html');
  });
});

describe('sumByName', () => {
  it('adds up the files that share a name once their hashes are gone', () => {
    const sums = sumByName([
      { name: 'host/assets/client.js', ...size(100) },
      { name: 'host/assets/index.js', ...size(40) },
      { name: 'host/assets/client.js', ...size(60) },
    ]);
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
    { name: 'host/a.js', ...size(100) },
    { name: 'host/new.js', ...size(50) },
  ]);

  it('takes the base total from the whole baseline, so a removed file and an added one both show', () => {
    const { total, baseTotal } = compare(current, {
      'host/a.js': size(100),
      'host/gone.js': size(30),
      'host/(eager path)': size(70),
    });
    assert.deepEqual(total, size(150));
    // a.js and gone.js. The eager path is a subset of the files, not a file.
    assert.deepEqual(baseTotal, size(130));
  });

  it('gives each file its baseline entry, or none for a file main does not have', () => {
    const { files } = compare(current, { 'host/a.js': size(90) });
    assert.deepEqual(
      files.map(({ name, base }) => [name, base]),
      [
        ['host/a.js', size(90)],
        ['host/new.js', null],
      ],
    );
  });

  it('has no base total without a baseline', () => {
    assert.equal(compare(current, null).baseTotal, null);
    assert.equal(compare(current, {}).baseTotal, null);
  });
});

describe('measureApp', () => {
  it('sizes each emitted file by its precompressed siblings and skips maps', () => {
    const dist = mkdtempSync(join(tmpdir(), 'bundle-sizes-'));
    try {
      mkdirSync(join(dist, 'assets'));
      writeFileSync(join(dist, 'index.html'), 'x'.repeat(10));
      writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js'), 'x'.repeat(100));
      writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js.br'), 'x'.repeat(30));
      writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js.gz'), 'x'.repeat(40));
      writeFileSync(join(dist, 'assets', 'app-AAAAAAAA.js.map'), 'x'.repeat(500));
      assert.deepEqual(measureApp('host', dist), [
        { name: 'host/assets/app.js', raw: 100, br: 30, gz: 40 },
        { name: 'host/index.html', raw: 10, br: 10, gz: 10 },
      ]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
