// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  parseExecutableManifest,
  parseRootManifest,
  validateExecutableManifest,
  validateRootManifest,
} from '../src/manifest-types.js';

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
  it('accepts a well-formed root', () => {
    const r = validateRootManifest(VALID_ROOT);
    expect(r.ok).toBe(true);
  });

  it('reports a $v other than 1 as an unsupported version, without checking the fields', () => {
    expect(validateRootManifest({ $v: 2, title: 'not a v1 shape' })).toEqual({
      ok: false,
      unsupportedVersion: 2,
      errors: ['root manifest $v 2 is not supported (expected 1)'],
    });
  });

  it('reports a missing $v as an unsupported version', () => {
    const { $v: _omitted, ...withoutVersion } = VALID_ROOT;
    expect(validateRootManifest(withoutVersion)).toMatchObject({ ok: false, unsupportedVersion: undefined });
  });

  it('rejects empty displayName', () => {
    const r = validateRootManifest({ ...VALID_ROOT, displayName: '' });
    expect(r.ok).toBe(false);
  });

  it('accepts an unrecognised icon.format, which only costs the icon', () => {
    expect(validateRootManifest({ ...VALID_ROOT, icon: { cid: 'bafy', format: 'gif' } }).ok).toBe(true);
  });

  it('rejects an icon.format that is not a string', () => {
    expect(validateRootManifest({ ...VALID_ROOT, icon: { cid: 'bafy', format: 7 } }).ok).toBe(false);
  });

  it('accepts trustedProducts, unrecognised grant values included', () => {
    expect(validateRootManifest({ ...VALID_ROOT, trustedProducts: { wallet: ['all', 'teleport'] } }).ok).toBe(true);
  });

  it.each([
    ['an array', ['wallet']],
    ['a grant list that is not an array', { wallet: 'all' }],
    ['a grant that is not a string', { wallet: [1] }],
  ])('rejects trustedProducts that is %s', (_case, trustedProducts) => {
    expect(validateRootManifest({ ...VALID_ROOT, trustedProducts }).ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateRootManifest(null).ok).toBe(false);
    expect(validateRootManifest('string').ok).toBe(false);
    expect(validateRootManifest([]).ok).toBe(false);
  });
});

describe('validateExecutableManifest', () => {
  it('accepts a valid app manifest', () => {
    expect(validateExecutableManifest(VALID_APP).ok).toBe(true);
  });

  it('accepts a valid widget manifest', () => {
    expect(validateExecutableManifest(VALID_WIDGET).ok).toBe(true);
  });

  it('accepts a valid worker manifest', () => {
    expect(validateExecutableManifest(VALID_WORKER).ok).toBe(true);
  });

  it('rejects appVersion of wrong length', () => {
    expect(validateExecutableManifest({ ...VALID_APP, appVersion: [1, 0] }).ok).toBe(false);
    expect(validateExecutableManifest({ ...VALID_APP, appVersion: [1, 0, 0, 0, 0] }).ok).toBe(false);
  });

  it('accepts appVersion build-tag as fourth element', () => {
    expect(
      validateExecutableManifest({
        ...VALID_APP,
        appVersion: [1, 0, 0, 'alpha'],
      }).ok,
    ).toBe(true);
  });

  it('rejects widget without dimensions.height', () => {
    const broken = {
      ...VALID_WIDGET,
      dimensions: { width: 1 } as { width: number; height?: number[] },
    };
    expect(validateExecutableManifest(broken).ok).toBe(false);
  });

  it('rejects worker entrypoint with leading slash', () => {
    expect(validateExecutableManifest({ ...VALID_WORKER, entrypoint: '/index.js' }).ok).toBe(false);
  });

  it.each([
    ['every surface off, a background-only worker', { chat: false, pocket: false, input: false }],
    ['omitted keys, which mean false', {}],
    ['the input surface', { input: true }],
  ])('accepts worker includes with %s', (_case, includes) => {
    expect(validateExecutableManifest({ ...VALID_WORKER, includes }).ok).toBe(true);
  });

  it('rejects worker includes with a non-boolean surface', () => {
    expect(validateExecutableManifest({ ...VALID_WORKER, includes: { chat: 'yes' } }).ok).toBe(false);
  });

  it('reports a $v other than 1 as an unsupported version, without checking the fields', () => {
    const v2 = { $v: 2, kind: 'app', appVersion: [0, 1, 9], runtime: { kind: 'polkavm', entrypoint: 'app.polkavm' } };
    expect(validateExecutableManifest(v2)).toEqual({
      ok: false,
      unsupportedVersion: 2,
      errors: ['executable manifest $v 2 is not supported (expected 1)'],
    });
  });

  it('rejects unknown kind', () => {
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
  it('parseRootManifest rejects malformed JSON', () => {
    const r = parseRootManifest('{ not valid');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/not valid JSON/);
    }
  });

  it('parseExecutableManifest accepts a stringified valid app', () => {
    const r = parseExecutableManifest(JSON.stringify(VALID_APP));
    expect(r.ok).toBe(true);
  });
});
