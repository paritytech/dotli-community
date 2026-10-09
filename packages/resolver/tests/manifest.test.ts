// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DotnsContracts } from '@dotli/config';
import { log } from '@dotli/shared';
import type { Api } from '../src/api.js';
import { readRootManifest } from '../src/manifest.js';
import { toExecutableManifestResult, toRootManifestResult } from '../src/manifest-types.js';

const storage = vi.hoisted(() => ({
  readNestedMappingString: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('../src/access-raw-storage.js', () => storage);

const DOTNS = {
  TLD: 'dot',
  DOTNS_CONTENT_RESOLVER: '0x1111111111111111111111111111111111111111',
  STORAGE_SLOTS: { TEXT_RECORDS: 3 },
} as unknown as DotnsContracts;

const ROOT = JSON.stringify({ $v: 1, displayName: 'DOOM', description: 'Doom', icon: { cid: 'bafk', format: 'png' } });
const APP = JSON.stringify({ $v: 1, kind: 'app', appVersion: [0, 1, 9] });
const FUTURE_APP = JSON.stringify({
  $v: 3,
  kind: 'app',
  appVersion: [0, 1, 9],
  runtime: { kind: 'polkavm', abiVersion: 1, entrypoint: 'app.polkavm' },
});

describe('toRootManifestResult', () => {
  it.each([null, ''])('reads %j as no manifest', raw => {
    expect(toRootManifestResult(raw)).toEqual({ kind: 'empty' });
  });

  it('keeps the record text next to a valid manifest', () => {
    expect(toRootManifestResult(ROOT)).toMatchObject({ kind: 'ok', value: { displayName: 'DOOM' }, raw: ROOT });
  });

  it('reports an unknown $v as an unsupported version', () => {
    const raw = JSON.stringify({ $v: 3 });
    expect(toRootManifestResult(raw)).toEqual({ kind: 'unsupported-version', version: 3, raw });
  });

  it('reports malformed JSON as invalid', () => {
    expect(toRootManifestResult('{ nope')).toMatchObject({ kind: 'invalid', raw: '{ nope' });
  });
});

describe('toExecutableManifestResult', () => {
  it('keeps the record text next to a valid manifest', () => {
    expect(toExecutableManifestResult(APP, 'app')).toMatchObject({ kind: 'ok', value: { kind: 'app' }, raw: APP });
  });

  it('reports an unknown app version as unsupported', () => {
    expect(toExecutableManifestResult(FUTURE_APP, 'app')).toEqual({
      kind: 'unsupported-version',
      version: 3,
      raw: FUTURE_APP,
    });
  });

  it('reports a manifest read from the wrong subname as invalid', () => {
    expect(toExecutableManifestResult(APP, 'worker')).toMatchObject({
      kind: 'invalid',
      raw: APP,
    });
  });

  it('reads an empty record as no manifest', () => {
    expect(toExecutableManifestResult(null, 'app')).toEqual({ kind: 'empty' });
  });
});

describe('readRootManifest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As a dotli maintainer, a manifest read leaves one breadcrumb with its size and verdict, never the record text', async () => {
    // Given
    const event = vi.spyOn(log, 'event').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    storage.readNestedMappingString.mockResolvedValueOnce(ROOT);

    // When
    const result = await readRootManifest({} as Api, DOTNS, 'doom');

    // Then
    expect(result).toMatchObject({ kind: 'ok' });
    expect(event.mock.calls).toEqual([
      [
        'Manifest read',
        { flow: 'resolve', kind: 'root', bytes: ROOT.length, outcome: 'ok', ms: expect.any(Number) as number },
      ],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('As a dotli maintainer, a manifest read that fails leaves its error in the trail', async () => {
    // Given
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const failure = new Error('storage read failed');
    storage.readNestedMappingString.mockRejectedValueOnce(failure);

    // When
    const result = readRootManifest({} as Api, DOTNS, 'doom');

    // Then
    await expect(result).rejects.toBe(failure);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[dot\.li manifest\] root manifest read failed/),
      failure,
    );
  });
});
