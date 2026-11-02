// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CachedManifests } from '@dotli/storage';
import { assertLaunchable } from './assertLaunchable.js';
import { toCachedManifest, type ProductManifests } from './cachedManifest.js';
import { ManifestRejectedError } from './manifestRejectedError.js';

export type RedeployDecision =
  { kind: 'update'; cid: string; manifests: CachedManifests } | { kind: 'evict'; reason: 'rejected' };

/** A redeploy is cached with its manifests, unless this host cannot read them. Rethrows any other failure. */
export function judgeRedeploy(cid: string, manifests: ProductManifests): RedeployDecision {
  try {
    assertLaunchable(manifests.root, manifests.app);
  } catch (error) {
    if (error instanceof ManifestRejectedError) {
      return { kind: 'evict', reason: 'rejected' };
    }
    throw error;
  }
  return { kind: 'update', cid, manifests: toCachedManifest(manifests) };
}
