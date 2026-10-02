// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from '@dotli/resolver';

import {
  assertLaunchable,
  fromCache,
  ManifestRejectedError,
  revalidateCachedProduct,
  toCache,
  type ProductManifests,
} from '../../src/manifest-gate.js';

const ROOT = toRootManifestResult(
  JSON.stringify({ $v: 1, displayName: 'DOOM', description: 'Doom', icon: { cid: 'bafk', format: 'png' } }),
);
const APP = toExecutableManifestResult(JSON.stringify({ $v: 1, kind: 'app', appVersion: [0, 1, 9] }), 'app');
const EMPTY = { kind: 'empty' } as const;
const NO_TEXT_RECORDS = { kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' } as const;
// What `app.doom.paseo` publishes.
const APP_V2 = toExecutableManifestResult(
  JSON.stringify({ $v: 2, kind: 'app', appVersion: [0, 1, 9], runtime: { kind: 'polkavm' } }),
  'app',
);

function rejection(
  root: ManifestResult<RootManifest>,
  app: ManifestResult<ExecutableManifest>,
): Pick<ManifestRejectedError, 'reason' | 'record'> | null {
  try {
    assertLaunchable(root, app);
    return null;
  } catch (err) {
    if (!(err instanceof ManifestRejectedError)) {
      throw err;
    }
    return { reason: err.reason, record: err.record };
  }
}

describe('manifest gate', () => {
  it.each([
    ['a product with no manifests, served by its contenthash alone', EMPTY, EMPTY],
    ['a product with valid root and app manifests', ROOT, APP],
    ['a product with a root manifest and no app manifest', ROOT, EMPTY],
    ['a network whose resolver has no text records', NO_TEXT_RECORDS, NO_TEXT_RECORDS],
  ])('As a dotli user, I can open %s', (_case, root, app) => {
    expect(rejection(root, app)).toBeNull();
  });

  it.each([
    [
      'an app manifest in a version this host does not read',
      ROOT,
      APP_V2,
      { reason: 'unsupported-version', record: 'app' },
    ],
    [
      'a root manifest in a version this host does not read',
      toRootManifestResult(JSON.stringify({ $v: 2 })),
      APP,
      { reason: 'unsupported-version', record: 'root' },
    ],
    ['a malformed root manifest', toRootManifestResult('{ nope'), APP, { reason: 'invalid', record: 'root' }],
    [
      'an app manifest read from the wrong subname',
      ROOT,
      toExecutableManifestResult(JSON.stringify({ $v: 1, kind: 'worker', appVersion: [1, 0, 0] }), 'app'),
      { reason: 'invalid', record: 'app' },
    ],
    ['an app manifest without a root manifest', EMPTY, APP, { reason: 'missing-root', record: 'root' }],
  ])('As a dotli user, I am told before any download that I cannot open %s', (_case, root, app, expected) => {
    expect(rejection(root, app)).toEqual(expected);
  });
});

describe('cached manifests', () => {
  const ROOT_TEXT = JSON.stringify({
    $v: 1,
    displayName: 'DOOM',
    description: 'Doom',
    icon: { cid: 'bafk', format: 'png' },
  });
  const APP_V2_TEXT = JSON.stringify({ $v: 2, kind: 'app', appVersion: [0, 1, 9] });

  it('As a dotli user, a cached app whose manifest this host does not read is rejected again on the next load', () => {
    // Given
    const cached = fromCache({ root: ROOT_TEXT, app: APP_V2_TEXT });

    // When
    const verdict = rejection(cached.root, cached.app);

    // Then
    expect(verdict).toEqual({ reason: 'unsupported-version', record: 'app' });
  });

  it('keeps the text of every record that has one, and null for the rest', () => {
    expect(toCache({ root: ROOT, app: EMPTY })).toEqual({ root: ROOT.kind === 'ok' ? ROOT.raw : '', app: null });
    expect(toCache({ root: NO_TEXT_RECORDS, app: APP_V2 })).toEqual({
      root: null,
      app: APP_V2.kind === 'unsupported-version' ? APP_V2.raw : '',
    });
  });
});

describe('cache revalidation', () => {
  const readManifests = (manifests: ProductManifests): Mock<() => Promise<ProductManifests>> =>
    vi.fn(() => Promise.resolve(manifests));

  it('As a dotli user, an app that was not redeployed keeps its cached manifests, without reading them again', async () => {
    // Given
    const read = readManifests({ root: ROOT, app: APP });

    // When
    const decision = await revalidateCachedProduct('bafy-served', () => Promise.resolve('bafy-served'), read);

    // Then
    expect(decision).toEqual({ kind: 'keep' });
    expect(read).not.toHaveBeenCalled();
  });

  it('As a dotli user, a redeployed app is cached again with the manifests it was redeployed with', async () => {
    // When
    const decision = await revalidateCachedProduct(
      'bafy-served',
      () => Promise.resolve('bafy-fresh'),
      readManifests({ root: ROOT, app: APP }),
    );

    // Then
    expect(decision).toEqual({ kind: 'update', cid: 'bafy-fresh', manifests: toCache({ root: ROOT, app: APP }) });
  });

  it('As a dotli user, an app redeployed with manifests this host cannot read is dropped from the cache', async () => {
    // When
    const decision = await revalidateCachedProduct(
      'bafy-served',
      () => Promise.resolve('bafy-fresh'),
      readManifests({ root: ROOT, app: APP_V2 }),
    );

    // Then
    expect(decision).toEqual({ kind: 'evict', reason: 'rejected' });
  });

  it('As a dotli user, an app whose name no longer resolves is dropped from the cache', async () => {
    // Given
    const read = readManifests({ root: ROOT, app: APP });

    // When
    const decision = await revalidateCachedProduct('bafy-served', () => Promise.resolve(null), read);

    // Then
    expect(decision).toEqual({ kind: 'evict', reason: 'cleared' });
    expect(read).not.toHaveBeenCalled();
  });
});
