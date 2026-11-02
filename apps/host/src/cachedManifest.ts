// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product's manifests as the CID cache keeps them: the raw text of each record, read again on the way out.

import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from '@dotli/resolver';
import type { CachedManifests } from '@dotli/storage';

export type ProductManifests = {
  root: ManifestResult<RootManifest>;
  app: ManifestResult<ExecutableManifest>;
};

/** Re-validates cached text with the validator this host ships today. Never throws. */
export function fromCachedManifest(cached: CachedManifests): ProductManifests {
  return { root: toRootManifestResult(cached.root), app: toExecutableManifestResult(cached.app, 'app') };
}

/** Returns the text of every record that has one, and null for the rest. */
export function toCachedManifest(manifests: ProductManifests): CachedManifests {
  const readRawText = (result: ManifestResult<unknown>): string | null => ('raw' in result ? result.raw : null);
  return { root: readRawText(manifests.root), app: readRawText(manifests.app) };
}
