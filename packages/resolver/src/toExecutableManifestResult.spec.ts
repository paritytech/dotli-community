// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toExecutableManifestResult } from './toExecutableManifestResult.js';

const APP = JSON.stringify({ $v: 1, kind: 'app', appVersion: [0, 1, 9] });
// What `app.doom.paseo` publishes: a schema this host does not read.
const APP_V2 = JSON.stringify({
  $v: 2,
  kind: 'app',
  appVersion: [0, 1, 9],
  runtime: { kind: 'polkavm', abiVersion: 1, entrypoint: 'app.polkavm' },
});

describe('toExecutableManifestResult', () => {
  it('As the host reading an executable manifest record, I keep its text next to the valid manifest', () => {
    // When
    const result = toExecutableManifestResult(APP, 'app');

    // Then
    expect(result).toMatchObject({ kind: 'ok', value: { kind: 'app' }, raw: APP });
  });

  it('As the host reading an executable manifest record, I report a v2 manifest as an unsupported version', () => {
    // When
    const result = toExecutableManifestResult(APP_V2, 'app');

    // Then
    expect(result).toEqual({
      kind: 'unsupported-version',
      version: '2',
      raw: APP_V2,
    });
  });

  it('As the host reading an executable manifest record, I report a manifest read from the wrong subname as invalid', () => {
    // When
    const result = toExecutableManifestResult(APP, 'worker');

    // Then
    expect(result).toEqual({
      kind: 'invalid',
      errors: ["executable manifest kind 'app' does not match its subname 'worker'"],
      raw: APP,
    });
  });

  it('As the host reading an executable manifest record, I read an empty record as no manifest', () => {
    // When
    const result = toExecutableManifestResult(null, 'app');

    // Then
    expect(result).toEqual({ kind: 'empty' });
  });
});
