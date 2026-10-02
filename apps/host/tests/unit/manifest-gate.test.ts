// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from '@dotli/resolver';

import { assertLaunchable, fromCache, ManifestRejectedError } from '../../src/manifest-gate.js';

const ROOT = toRootManifestResult(
  JSON.stringify({ $v: 1, displayName: 'DOOM', description: 'Doom', icon: { cid: 'bafk', format: 'png' } }),
);
const APP = toExecutableManifestResult(JSON.stringify({ $v: 1, kind: 'app', appVersion: [0, 1, 9] }), 'app');
const EMPTY = { kind: 'empty' } as const;
const NO_TEXT_RECORDS = { kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' } as const;
const APP_V2 = toExecutableManifestResult(
  JSON.stringify({
    $v: 2,
    kind: 'app',
    appVersion: [0, 1, 9],
    runtime: { kind: 'polkavm', abiVersion: 1, entrypoint: 'app.polkavm' },
    capabilities: { graphics: { abiVersion: 1, profile: 'framebuffer', requiredFeatures: [] } },
  }),
  'app',
);
const FUTURE_APP = toExecutableManifestResult(JSON.stringify({ $v: 3, kind: 'app' }), 'app');

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
    ['a PolkaVM app with a supported v2 manifest', ROOT, APP_V2],
    ['a product with a root manifest and no app manifest', ROOT, EMPTY],
    ['a network whose resolver has no text records', NO_TEXT_RECORDS, NO_TEXT_RECORDS],
  ])('As a dotli user, I can open %s', (_case, root, app) => {
    expect(rejection(root, app)).toBeNull();
  });

  it.each([
    [
      'an app manifest in a version this host does not read',
      ROOT,
      FUTURE_APP,
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
    [
      'a malformed v2 app in a supported schema',
      ROOT,
      toExecutableManifestResult(JSON.stringify({ $v: 2, kind: 'app', appVersion: [0, 1, 9] }), 'app'),
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
  const FUTURE_APP_TEXT = JSON.stringify({ $v: 3, kind: 'app' });

  it('As a dotli user, a cached app whose manifest this host does not read is rejected again on the next load', () => {
    // Given
    const cached = fromCache({ root: ROOT_TEXT, app: FUTURE_APP_TEXT });

    // When
    const verdict = rejection(cached.root, cached.app);

    // Then
    expect(verdict).toEqual({ reason: 'unsupported-version', record: 'app' });
  });
});
