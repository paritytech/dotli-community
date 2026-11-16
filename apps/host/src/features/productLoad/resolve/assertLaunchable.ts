// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Decided before any content is fetched. A product with no manifests is served by its contenthash alone, and one
// whose manifests this host cannot read is not opened.

import type { ExecutableManifest, ManifestResult, RootManifest } from '@dotli/resolver';
import { ManifestRejectedError } from './manifestRejectedError.js';

/** A network without text records counts as no manifests. Throws `ManifestRejectedError` for manifests it cannot open. */
export function assertLaunchable(root: ManifestResult<RootManifest>, app: ManifestResult<ExecutableManifest>): void {
  assertReadable(root, 'root');
  if (!isPresent(root) && isPresent(app)) {
    throw new ManifestRejectedError('missing-root', 'root', 'an app manifest is published without a root manifest');
  }
  assertReadable(app, 'app');
}

function isPresent(result: ManifestResult<unknown>): boolean {
  return result.kind !== 'empty' && result.kind !== 'unsupported';
}

function assertReadable(result: ManifestResult<unknown>, record: 'root' | 'app'): void {
  if (result.kind === 'unsupported-version') {
    throw new ManifestRejectedError('unsupported-version', record, `$v ${result.version}`);
  }
  if (result.kind === 'invalid') {
    throw new ManifestRejectedError('invalid', record, result.errors.join('; '));
  }
}
