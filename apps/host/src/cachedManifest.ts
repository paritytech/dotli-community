// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product's manifests as the CID cache keeps them: the raw text of each record, read again on the way out, and the
// product's dotNS owner beside them.

import { reportExpected, spans as S } from '@dotli/metrics';
import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from '@dotli/resolver';
import type { CachedManifests } from '@dotli/storage';
import { parseH160Address, type H160Address } from './h160Address.js';

export type ProductManifests = {
  root: ManifestResult<RootManifest>;
  app: ManifestResult<ExecutableManifest>;
  /** The product's dotNS owner address, `null` for a name with none. Absent when the owner is unknown. */
  owner?: H160Address | null;
};

type FromCachedManifestParams = {
  /** Hears a cached owner that is no address. */
  report?: (error: unknown) => void;
};

/**
 * Re-validates cached text with the validator this host ships today. Never throws: a cached owner that is no address
 * reads as unknown and goes to `report`.
 */
export function fromCachedManifest(
  cached: CachedManifests,
  { report = reportCachedOwner }: FromCachedManifestParams = {},
): ProductManifests {
  const manifests = { root: toRootManifestResult(cached.root), app: toExecutableManifestResult(cached.app, 'app') };
  const owner = readCachedOwner(cached.owner, report);
  return owner === undefined ? manifests : { ...manifests, owner };
}

/** Returns the text of every record that has one, and null for the rest, with the owner when it is known. */
export function toCachedManifest(manifests: ProductManifests): CachedManifests {
  const readRawText = (result: ManifestResult<unknown>): string | null => ('raw' in result ? result.raw : null);
  const cached = { root: readRawText(manifests.root), app: readRawText(manifests.app) };
  return manifests.owner === undefined ? cached : { ...cached, owner: manifests.owner };
}

/** Parses the cached owner. One that is no address reads as unknown, and its error goes to `report`. */
function readCachedOwner(
  owner: string | null | undefined,
  report: (error: unknown) => void,
): H160Address | null | undefined {
  if (owner === undefined || owner === null) {
    return owner;
  }
  try {
    return parseH160Address(owner);
  } catch (error) {
    report(error);
    return undefined;
  }
}

// Only a hand-edited store holds such an owner, and the author is not worth failing the load for.
function reportCachedOwner(error: unknown): void {
  reportExpected(error, { flow: 'resolve', step: 'cached_owner', metric: S.PRODUCT_AUTHOR, reason: 'cached-owner' });
}
