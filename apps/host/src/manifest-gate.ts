// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Decided before any content is fetched. A product with no manifests is served by its contenthash alone, and one
// whose manifests this host cannot read is not opened.

import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from '@dotli/resolver';
import type { ManifestFacts } from './runtime/manifest-facts.js';
import type { CachedManifests } from '@dotli/storage';

export interface ProductManifests {
  root: ManifestResult<RootManifest>;
  app: ManifestResult<ExecutableManifest>;
}

/** Re-validates cached text with the validator this host ships today. */
export function fromCache(cached: CachedManifests): ProductManifests {
  return { root: toRootManifestResult(cached.root), app: toExecutableManifestResult(cached.app, 'app') };
}

export function toCache(manifests: ProductManifests): CachedManifests {
  const text = (result: ManifestResult<unknown>): string | null => ('raw' in result ? result.raw : null);
  return { root: text(manifests.root), app: text(manifests.app) };
}

/** What the manifests publish that the page shows, without the keys they lack. */
export function manifestFacts({ root, app }: ProductManifests): ManifestFacts {
  return {
    ...(root.kind === 'ok' ? { displayName: root.value.displayName, manifestVersion: root.value.$v } : {}),
    ...(app.kind === 'ok' && app.value.kind === 'app' ? { appVersion: app.value.appVersion } : {}),
  };
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
    throw new ManifestRejectedError('unsupported-version', record, `$v ${result.version}`);
  }
  if (result.kind === 'invalid') {
    throw new ManifestRejectedError('invalid', record, result.errors.join('; '));
  }
}

/** A network without text records counts as no manifests. */
export function assertLaunchable(root: ManifestResult<RootManifest>, app: ManifestResult<ExecutableManifest>): void {
  assertReadable(root, 'root');
  if (!present(root) && present(app)) {
    throw new ManifestRejectedError('missing-root', 'root', 'an app manifest is published without a root manifest');
  }
  assertReadable(app, 'app');
}

/** A redeploy moves the contenthash, so the CID alone tells whether a cached copy is current. */
export type CidComparison = { kind: 'keep' } | { kind: 'evict'; reason: 'cleared' } | { kind: 'newer'; cid: string };

export function compareCachedCid(servedCid: string, freshCid: string | null): CidComparison {
  if (freshCid === null) {
    return { kind: 'evict', reason: 'cleared' };
  }
  return freshCid === servedCid ? { kind: 'keep' } : { kind: 'newer', cid: freshCid };
}

export type RedeployDecision =
  { kind: 'update'; cid: string; manifests: CachedManifests } | { kind: 'evict'; reason: 'rejected' };

/** A redeploy is cached with its manifests, unless this host cannot read them. */
export function judgeRedeploy(cid: string, manifests: ProductManifests): RedeployDecision {
  try {
    assertLaunchable(manifests.root, manifests.app);
  } catch (err) {
    if (err instanceof ManifestRejectedError) {
      return { kind: 'evict', reason: 'rejected' };
    }
    throw err;
  }
  return { kind: 'update', cid, manifests: toCache(manifests) };
}
