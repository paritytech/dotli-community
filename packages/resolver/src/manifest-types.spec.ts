// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  parseExecutableManifest,
  parseRootManifest,
  validateExecutableManifest,
  validateRootManifest,
} from './manifest-types.js';

const VALID_ROOT = {
  $v: 1,
  displayName: 'HackM3',
  description: 'A note-taking app',
  icon: { cid: 'bafy...icon', format: 'png' },
};

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

describe('validateRootManifest', () => {
  it('As the host validating a root manifest, I accept a well-formed one', () => {
    // When
    const r = validateRootManifest(VALID_ROOT);

    // Then
    expect(r.ok).toBe(true);
  });

  it('As the host validating a root manifest, I report a $v other than 1 as an unsupported version without checking its fields', () => {
    // When / Then
    expect(validateRootManifest({ $v: 2, title: 'not a v1 shape' })).toEqual({
      ok: false,
      unsupportedVersion: 2,
      errors: ['root manifest $v 2 is not supported (expected 1)'],
    });
  });

  it('As the host validating a root manifest, I report a missing $v as an unsupported version', () => {
    // Given
    const { $v: _omitted, ...withoutVersion } = VALID_ROOT;

    // When / Then
    expect(validateRootManifest(withoutVersion)).toMatchObject({ ok: false, unsupportedVersion: undefined });
  });

  it('As the host validating a root manifest, I refuse an empty display name', () => {
    // When
    const r = validateRootManifest({ ...VALID_ROOT, displayName: '' });

    // Then
    expect(r.ok).toBe(false);
  });

  it('As the host validating a root manifest, I accept an unrecognised icon format, which only costs the icon', () => {
    // When / Then
    expect(validateRootManifest({ ...VALID_ROOT, icon: { cid: 'bafy', format: 'gif' } }).ok).toBe(true);
  });

  it('As the host validating a root manifest, I refuse an icon format that is not a string', () => {
    // When / Then
    expect(validateRootManifest({ ...VALID_ROOT, icon: { cid: 'bafy', format: 7 } }).ok).toBe(false);
  });

  it('As the host validating a root manifest, I accept trusted products, unrecognised grant values included', () => {
    // When / Then
    expect(validateRootManifest({ ...VALID_ROOT, trustedProducts: { wallet: ['all', 'teleport'] } }).ok).toBe(true);
  });

  it.each([
    ['an array', ['wallet']],
    ['a grant list that is not an array', { wallet: 'all' }],
    ['a grant that is not a string', { wallet: [1] }],
  ])('As the host validating a root manifest, I refuse trusted products given as %s', (_case, trustedProducts) => {
    // When / Then
    expect(validateRootManifest({ ...VALID_ROOT, trustedProducts }).ok).toBe(false);
  });

  it('As the host validating a root manifest, I refuse input that is not an object', () => {
    // When / Then
    expect(validateRootManifest(null).ok).toBe(false);
    expect(validateRootManifest('string').ok).toBe(false);
    expect(validateRootManifest([]).ok).toBe(false);
  });
});

describe('validateExecutableManifest', () => {
  it('As the host validating an executable manifest, I accept a valid app manifest', () => {
    // When / Then
    expect(validateExecutableManifest(VALID_APP).ok).toBe(true);
  });

  it('As the host validating an executable manifest, I accept a valid widget manifest', () => {
    // When / Then
    expect(validateExecutableManifest(VALID_WIDGET).ok).toBe(true);
  });

  it('As the host validating an executable manifest, I accept a valid worker manifest', () => {
    // When / Then
    expect(validateExecutableManifest(VALID_WORKER).ok).toBe(true);
  });

  it('As the host validating an executable manifest, I refuse an app version of the wrong length', () => {
    // When / Then
    expect(validateExecutableManifest({ ...VALID_APP, appVersion: [1, 0] }).ok).toBe(false);
    expect(validateExecutableManifest({ ...VALID_APP, appVersion: [1, 0, 0, 0, 0] }).ok).toBe(false);
  });

  it('As the host validating an executable manifest, I accept a build tag as the fourth app version element', () => {
    // When / Then
    expect(
      validateExecutableManifest({
        ...VALID_APP,
        appVersion: [1, 0, 0, 'alpha'],
      }).ok,
    ).toBe(true);
  });

  it('As the host validating an executable manifest, I refuse a widget without a height', () => {
    // Given
    const broken = {
      ...VALID_WIDGET,
      dimensions: { width: 1 } as { width: number; height?: number[] },
    };

    // When / Then
    expect(validateExecutableManifest(broken).ok).toBe(false);
  });

  it('As the host validating an executable manifest, I refuse a worker entrypoint with a leading slash', () => {
    // When / Then
    expect(validateExecutableManifest({ ...VALID_WORKER, entrypoint: '/index.js' }).ok).toBe(false);
  });

  it.each([
    ['every surface off, a background-only worker', { chat: false, pocket: false, input: false }],
    ['omitted keys, which mean false', {}],
    ['the input surface', { input: true }],
  ])('As the host validating an executable manifest, I accept worker includes with %s', (_case, includes) => {
    // When / Then
    expect(validateExecutableManifest({ ...VALID_WORKER, includes }).ok).toBe(true);
  });

  it('As the host validating an executable manifest, I refuse worker includes with a surface that is not a boolean', () => {
    // When / Then
    expect(validateExecutableManifest({ ...VALID_WORKER, includes: { chat: 'yes' } }).ok).toBe(false);
  });

  it('As the host validating an executable manifest, I report a $v other than 1 as an unsupported version without checking its fields', () => {
    // Given
    const v2 = { $v: 2, kind: 'app', appVersion: [0, 1, 9], runtime: { kind: 'polkavm', entrypoint: 'app.polkavm' } };

    // When / Then
    expect(validateExecutableManifest(v2)).toEqual({
      ok: false,
      unsupportedVersion: 2,
      errors: ['executable manifest $v 2 is not supported (expected 1)'],
    });
  });

  it('As the host validating an executable manifest, I refuse an unknown kind', () => {
    // When / Then
    expect(
      validateExecutableManifest({
        $v: 1,
        kind: 'daemon',
        appVersion: [1, 0, 0],
        cid: 'bafy',
      }).ok,
    ).toBe(false);
  });
});

describe('parse* helpers', () => {
  it('As the host validating a root manifest, I refuse record text that is not JSON', () => {
    // When
    const r = parseRootManifest('{ not valid');

    // Then
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/not valid JSON/);
    }
  });

  it('As the host validating an executable manifest, I accept the record text of a valid app', () => {
    // When
    const r = parseExecutableManifest(JSON.stringify(VALID_APP));

    // Then
    expect(r.ok).toBe(true);
  });
});
