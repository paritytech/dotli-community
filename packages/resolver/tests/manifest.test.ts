// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toExecutableManifestResult, toRootManifestResult } from '../src/manifest.js';

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
