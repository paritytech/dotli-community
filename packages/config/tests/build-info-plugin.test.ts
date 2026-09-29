// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo } from '../src/build-info-plugin.js';

type Output = { type: 'chunk'; code: string } | { type: 'asset'; source: string | Uint8Array };

/** Runs the plugin's hooks against `root` and `bundle`, returns the JSON. */
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

  it('reports the build, the package version and a content hash', () => {
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');
    expect(emit(dir, BUNDLE)).toEqual({
      build: 'host',
      version: '1.2.3',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
  });

  it('reports 0.0.0 without a package.json', () => {
    expect(emit(dir, BUNDLE)).toMatchObject({ version: '0.0.0' });
  });

  it('hashes contents, independent of bundle order', () => {
    const hashOf = (bundle: Record<string, Output>): string => (emit(dir, bundle) as { hash: string }).hash;
    const reordered = Object.fromEntries(Object.entries(BUNDLE).reverse());
    expect(hashOf(reordered)).toBe(hashOf(BUNDLE));
    expect(
      hashOf({
        ...BUNDLE,
        'assets/index-abc.js': { type: 'chunk', code: 'console.log(2)' },
      }),
    ).not.toBe(hashOf(BUNDLE));
  });
});
