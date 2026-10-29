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

import { assertLaunchable } from './assertLaunchable.js';
import { ManifestRejectedError } from './manifestRejectedError.js';
import { APP, APP_V2, EMPTY, NO_TEXT_RECORDS, ROOT } from './testing/manifestFixtures.js';

describe('manifest gate', () => {
  it.each([
    ['a product with no manifests, served by its contenthash alone', EMPTY, EMPTY],
    ['a product with valid root and app manifests', ROOT, APP],
    ['a product with a root manifest and no app manifest', ROOT, EMPTY],
    ['a network whose resolver has no text records', NO_TEXT_RECORDS, NO_TEXT_RECORDS],
  ])('As a dotli user, I open %s and nothing stops the load', (_case, root, app) => {
    // When
    const rejection = getRejection(root, app);

    // Then
    expect(rejection).toBeNull();
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
  ])(
    'As a dotli user, I open a product with %s and am told before any download that it cannot open',
    (_case, root, app, expected) => {
      // When
      const rejection = getRejection(root, app);

      // Then
      expect(rejection).toEqual(expected);
    },
  );
});

/** Returns why the gate refuses the manifests, or null when it lets them launch. Rethrows any other failure. */
function getRejection(
  root: ManifestResult<RootManifest>,
  app: ManifestResult<ExecutableManifest>,
): Pick<ManifestRejectedError, 'reason' | 'record'> | null {
  try {
    assertLaunchable(root, app);
    return null;
  } catch (error) {
    if (!(error instanceof ManifestRejectedError)) {
      throw error;
    }
    return { reason: error.reason, record: error.record };
  }
}
