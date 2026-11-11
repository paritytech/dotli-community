// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseExecutableManifest, validateExecutableManifest } from './validateExecutableManifest.js';

const VALID_APP = {
  $v: 1,
  kind: 'app',
  appVersion: [1, 0, 0],
};

const VALID_WIDGET = {
  $v: 1,
  kind: 'widget',
  appVersion: [1, 0, 0],
  dimensions: { height: [2, 4], width: 1 },
};

const VALID_WORKER = {
  $v: 1,
  kind: 'worker',
  appVersion: [1, 0, 0],
  entrypoint: 'index.js',
  includes: { chat: true, pocket: false },
};

describe('validateExecutableManifest', () => {
  it.each([
    ['app', VALID_APP],
    ['widget', VALID_WIDGET],
    ['worker', VALID_WORKER],
  ])('As the host validating an executable manifest, I accept a valid %s manifest', (_kind, manifest) => {
    // When
    const result = validateExecutableManifest(manifest);

    // Then
    expect(result.ok).toBe(true);
  });

  it.each([
    ['with too few parts', [1, 0]],
    ['with a part that is no whole number', [1.5, 0, 0]],
    ['with too many parts', [1, 0, 0, 0, 0]],
  ])('As the host validating an executable manifest, I refuse an app version %s', (_case, appVersion) => {
    // When
    const result = validateExecutableManifest({ ...VALID_APP, appVersion });

    // Then
    expect(result.ok).toBe(false);
  });

  it('As the host validating an executable manifest, I accept a build tag as the fourth app version element', () => {
    // When
    const result = validateExecutableManifest({
      ...VALID_APP,
      appVersion: [1, 0, 0, 'alpha'],
    });

    // Then
    expect(result.ok).toBe(true);
  });

  it('As the host validating an executable manifest, I refuse a widget without a height', () => {
    // Given
    const broken = {
      ...VALID_WIDGET,
      dimensions: { width: 1 },
    };

    // When
    const result = validateExecutableManifest(broken);

    // Then
    expect(result.ok).toBe(false);
  });

  it.each(['/index.js', '\\x.js', 'a\\..\\..\\x.js', '%2e%2E/x.js'])(
    'As the host validating an executable manifest, I refuse a worker entrypoint that escapes its directory as %s',
    entrypoint => {
      // When
      const result = validateExecutableManifest({ ...VALID_WORKER, entrypoint });

      // Then
      expect(result.ok).toBe(false);
    },
  );

  it.each(['./a.js', 'a..b.js'])(
    'As the host validating an executable manifest, I accept a worker entrypoint %s',
    entrypoint => {
      // When
      const result = validateExecutableManifest({ ...VALID_WORKER, entrypoint });

      // Then
      expect(result.ok).toBe(true);
    },
  );

  it.each([
    ['every surface off, a background-only worker', { chat: false, pocket: false, input: false }],
    ['omitted keys, which mean false', {}],
    ['the input surface', { input: true }],
  ])('As the host validating an executable manifest, I accept worker includes with %s', (_case, includes) => {
    // When
    const result = validateExecutableManifest({ ...VALID_WORKER, includes });

    // Then
    expect(result.ok).toBe(true);
  });

  it('As the host validating an executable manifest, I refuse worker includes with a surface that is not a boolean', () => {
    // When
    const result = validateExecutableManifest({ ...VALID_WORKER, includes: { chat: 'yes' } });

    // Then
    expect(result.ok).toBe(false);
  });

  it('As the host validating an executable manifest, I report a $v other than 1 as an unsupported version without checking its fields', () => {
    // Given
    const v2 = { $v: 2, kind: 'app', appVersion: [0, 1, 9], runtime: { kind: 'polkavm', entrypoint: 'app.polkavm' } };

    // When
    const result = validateExecutableManifest(v2);

    // Then
    expect(result).toEqual({
      ok: false,
      unsupportedVersion: 2,
      errors: ['executable manifest $v 2 is not supported (expected 1)'],
    });
  });

  it('As the host validating an executable manifest, I refuse an unknown kind', () => {
    // When
    const result = validateExecutableManifest({
      $v: 1,
      kind: 'daemon',
      appVersion: [1, 0, 0],
      cid: 'bafy',
    });

    // Then
    expect(result.ok).toBe(false);
  });
});

describe('parseExecutableManifest', () => {
  it('As the host validating an executable manifest, I accept the record text of a valid app', () => {
    // When
    const result = parseExecutableManifest(JSON.stringify(VALID_APP));

    // Then
    expect(result.ok).toBe(true);
  });
});
