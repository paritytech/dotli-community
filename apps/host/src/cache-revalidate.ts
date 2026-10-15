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
    /** Resolves to whether the entry is gone. */
    evict: (label: string) => Promise<boolean>;
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
      m.count(S.CACHE_REVALIDATE, { outcome: 'match' });
      return;
    }
    if (decision.kind === 'update') {
      await deps.cache.set(label, decision.cid, decision.manifests);
      m.count(S.CACHE_REVALIDATE, { outcome: 'update' });
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
    const evicted = await deps.cache.evict(label);
    if (!evicted) {
      // The label still holds the stale CID, so a reload would serve it again and loop. Storage reported the failure.
      m.count(S.CACHE_REVALIDATE, { outcome: 'error', reason: 'evict_failed' });
      log.event('Cached app could not be evicted', { flow: 'resolve', served: servedCid, reason: decision.reason });
      return;
    }
    m.count(S.CACHE_REVALIDATE, { outcome: 'cleared' });
    log.event('Cached app evicted', { flow: 'resolve', served: servedCid, reason: decision.reason });
    if (onScreen) {
      deps.reload();
    }
  } catch (err) {
    stopTimer();
    m.count(S.CACHE_REVALIDATE, { outcome: 'error' });
    captureException(err, {
      flow: 'resolve',
      step: 'cache_revalidate',
      tags: { kind: 'cid_cache_revalidate_error', surface: 'host_cache_revalidate' },
    });
  }
}
