// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a product's manifests let it be opened, decided before any of its
// content is fetched (product-manifest RFC, "Resolving a product"). A product
// with no manifests at all is served by its contenthash alone, as before
// manifests existed; one whose manifests this host cannot read is not opened.

import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from '@dotli/resolver';
import type { CachedManifests } from '@dotli/storage';

/** A product's root manifest and its `app.` executable manifest. */
export interface ProductManifests {
  root: ManifestResult<RootManifest>;
  app: ManifestResult<ExecutableManifest>;
}

/** Judge cached manifest text again, by the validator this host ships today. */
export function fromCache(cached: CachedManifests): ProductManifests {
  return { root: toRootManifestResult(cached.root), app: toExecutableManifestResult(cached.app, 'app') };
}

/** The record text to cache next to the CID: `null` for a record that has none. */
export function toCache(manifests: ProductManifests): CachedManifests {
  const text = (result: ManifestResult<unknown>): string | null => ('raw' in result ? result.raw : null);
  return { root: text(manifests.root), app: text(manifests.app) };
}

export type ManifestRejection = 'unsupported-version' | 'invalid' | 'missing-root';

/** A product whose manifests rule out opening it. Deterministic: a reload reads the same records. */
export class ManifestRejectedError extends Error {
  readonly reason: ManifestRejection;
  readonly record: 'root' | 'app';

  constructor(reason: ManifestRejection, record: 'root' | 'app', detail: string) {
    super(`${record} manifest ${reason}: ${detail}`);
    this.name = 'ManifestRejectedError';
    this.reason = reason;
    this.record = record;
  }
}

function present(result: ManifestResult<unknown>): boolean {
  return result.kind !== 'empty' && result.kind !== 'unsupported';
}

function assertReadable(result: ManifestResult<unknown>, record: 'root' | 'app'): void {
  if (result.kind === 'unsupported-version') {
    throw new ManifestRejectedError(
      'unsupported-version',
      record,
      `$v ${result.version === undefined ? 'undefined' : JSON.stringify(result.version)}`,
    );
  }
  if (result.kind === 'invalid') {
    throw new ManifestRejectedError('invalid', record, result.errors.join('; '));
  }
}

/**
 * Throw `ManifestRejectedError` unless the root and app manifests let the
 * product be opened. A network without text records counts as no manifests.
 */
export function assertLaunchable(root: ManifestResult<RootManifest>, app: ManifestResult<ExecutableManifest>): void {
  assertReadable(root, 'root');
  if (!present(root) && present(app)) {
    throw new ManifestRejectedError('missing-root', 'root', 'an app manifest is published without a root manifest');
  }
  assertReadable(app, 'app');
}

