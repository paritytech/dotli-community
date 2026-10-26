// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product served from the CID cache is checked against the network after it renders, so the cache stays honest
// without holding the render back.

import { captureException, m, spans as S } from '@dotli/metrics';
import type { CachedManifests } from '@dotli/storage';
import { errorName, log } from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui';
import { compareCachedCid, judgeRedeploy } from './manifest-gate.js';
import type { NameSource } from './name-source.js';

export type CacheRevalidationDeps = {
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
};

/** `onScreen` is false when the cached copy was refused rather than rendered, so an eviction has no page to reload. */
export async function revalidateCachedCopy(
  label: string,
  servedCid: string,
  onScreen: boolean,
  deps: CacheRevalidationDeps,
): Promise<void> {
  /** Resolves to whether it reloaded the page. */
  const drop = async (reason: 'cleared' | 'rejected'): Promise<boolean> => {
    // Reloading takes the cold path, which shows why.
    const evicted = await deps.cache.evict(label);
    if (!evicted) {
      // The label still holds the stale CID, so a reload would serve it again and loop. Storage reported the failure.
      m.count(S.CACHE_REVALIDATE, { outcome: 'error', reason: 'evict_failed' });
      log.event('Cached app could not be evicted', { flow: 'resolve', served: servedCid, reason });
      return false;
    }
    m.count(S.CACHE_REVALIDATE, { outcome: 'cleared', reason });
    log.event('Cached app evicted', { flow: 'resolve', served: servedCid, reason });
    if (onScreen) {
      deps.reload();
    }
    return onScreen;
  };

  /** Resolves to whether it reloaded the page. */
  const adopt = async (cid: string): Promise<boolean> => {
    const decision = judgeRedeploy(cid, await deps.names.readManifests(label));
    if (decision.kind === 'evict') {
      return drop(decision.reason);
    }
    await deps.cache.set(label, decision.cid, decision.manifests);
    m.count(S.CACHE_REVALIDATE, { outcome: 'update' });
    log.event('Cached app is outdated', { flow: 'resolve', served: servedCid, latest: cid });
    return false;
  };

  try {
    const found = compareCachedCid(servedCid, await lookUpCid(label, deps.names));
    if (found.kind === 'keep') {
      m.count(S.CACHE_REVALIDATE, { outcome: 'match' });
      return;
    }
    if (found.kind === 'evict') {
      await drop(found.reason);
      return;
    }
    // Offered before the new manifests are read. A Reload pressed meanwhile waits for the new version to be cached, or
    // it would serve the old copy again.
    const adopted = adopt(found.cid);
    deps.notify({
      label: 'New version available',
      text: 'This site has been updated. Reload to see the latest version.',
      dismissMs: 0,
      action: {
        label: 'Reload',
        onClick: () => {
          void adopted.then(
            reloaded => {
              if (!reloaded) {
                deps.reload();
              }
            },
            // Reported where it is awaited below.
            () => {
              deps.reload();
            },
          );
        },
      },
    });
    await adopted;
  } catch (err: unknown) {
    captureException(err, {
      flow: 'resolve',
      step: 'cache_revalidate',
      tags: { kind: 'cid_cache_revalidate_error', surface: 'host_cache_revalidate' },
    });
    log.error('[dot.li] Cached copy revalidation failed:', err);
    m.count(S.CACHE_REVALIDATE, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
  }
}

/** Timed alone, since the network's answer is what the visitor waits on. */
async function lookUpCid(label: string, names: CacheRevalidationDeps['names']): Promise<string | null> {
  const stopTimer = m.timer(S.CACHE_REVALIDATE_LATENCY);
  try {
    // The same lookup the load made, or a product published under its app subname never matches.
    return await names.resolveProduct(label);
  } finally {
    stopTimer();
  }
}
