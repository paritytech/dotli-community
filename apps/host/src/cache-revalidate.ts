// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product served from the CID cache is checked against the network after it renders, so the cache stays honest
// without holding the render back.

import { captureException, m, spans as S } from '@dotli/metrics';
import type { CachedManifests } from '@dotli/storage';
import { log } from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui';
import { revalidateCachedProduct } from './manifest-gate.js';
import type { NameSource } from './name-source.js';

export interface CacheRevalidationDeps {
  names: Pick<NameSource, 'resolveProduct' | 'readManifests'>;
  /** The CID cache entry for this network. */
  cache: {
    set: (label: string, cid: string, manifests: CachedManifests) => Promise<void>;
    evict: (label: string) => Promise<void>;
  };
  notify: ShowNotification;
  /** Reloads onto the newer version. */
  reload: () => void;
}

/** `onScreen` is false when the cached copy was refused rather than rendered, so an eviction has no page to reload. */
export async function revalidateCachedCopy(
  label: string,
  servedCid: string,
  onScreen: boolean,
  deps: CacheRevalidationDeps,
): Promise<void> {
  const stopTimer = m.timer(S.CACHE_REVALIDATE_LATENCY);
  try {
    const decision = await revalidateCachedProduct(
      servedCid,
      // The same lookup the load made, or a product published under its app subname never matches.
      () => deps.names.resolveProduct(label),
      () => deps.names.readManifests(label),
    );
    stopTimer();
    if (decision.kind === 'keep') {
      m.count(S.CACHE_REVALIDATE_MATCH);
      return;
    }
    if (decision.kind === 'update') {
      await deps.cache.set(label, decision.cid, decision.manifests);
      m.count(S.CACHE_REVALIDATE_UPDATE);
      log.event('Cached app is outdated', { flow: 'resolve', served: servedCid, latest: decision.cid });
      deps.notify({
        label: 'New version available',
        text: 'This site has been updated. Reload to see the latest version.',
        dismissMs: 0,
        action: { label: 'Reload', onClick: deps.reload },
      });
      return;
    }
    // Cleared, or redeployed with manifests this host cannot read. Reloading takes the cold path, which shows why.
    await deps.cache.evict(label);
    m.count(S.CACHE_REVALIDATE_CLEARED);
    log.event('Cached app evicted', { flow: 'resolve', served: servedCid, reason: decision.reason });
    if (onScreen) {
      deps.reload();
    }
  } catch (err) {
    stopTimer();
    m.count(S.CACHE_REVALIDATE_ERROR);
    captureException(err, {
      flow: 'resolve',
      step: 'cache_revalidate',
      tags: { kind: 'cid_cache_revalidate_error', surface: 'host_cache_revalidate' },
    });
  }
}
