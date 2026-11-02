// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product served from the CID cache is checked against the network after it renders, so the cache stays honest
// without holding the render back.

import { m, reportDefect, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui';
import { compareCachedCid } from './compareCachedCid.js';
import { judgeRedeploy } from './judgeRedeploy.js';
import type { NameSource } from './createNameSource.js';
import type { CachedCopy, ServedCopy } from './createProductLoader.js';

export type RevalidateCachedCopyParams = ServedCopy & {
  names: Pick<NameSource, 'resolveProduct' | 'readManifests'>;
  /** The CID cache entry for this network. */
  cache: {
    /** Keeps `copy` in place of the label's entry. */
    set: (copy: CachedCopy) => Promise<void>;
    /** Resolves to whether the entry is gone. */
    evict: (label: string) => Promise<boolean>;
  };
  notify: ShowNotification;
  /** Reloads onto the newer version. */
  reload: () => void;
};

/** Checks the served copy against the network and drops or replaces it. Never rejects: a failure is reported here. */
export async function revalidateCachedCopy({
  label,
  servedCid,
  onScreen,
  ...params
}: RevalidateCachedCopyParams): Promise<void> {
  /** Resolves to whether it reloaded the page. */
  async function drop(reason: 'cleared' | 'rejected'): Promise<boolean> {
    // Reloading takes the cold path, which shows why.
    const evicted = await params.cache.evict(label);
    if (!evicted) {
      // The label still holds the stale CID, so a reload would serve it again and loop. Storage reported the failure.
      m.count(S.CACHE_REVALIDATE, { outcome: 'error', reason: 'evict_failed' });
      log.event('Cached app could not be evicted', { flow: 'resolve', served: servedCid, reason });
      return false;
    }
    m.count(S.CACHE_REVALIDATE, { outcome: 'cleared', reason });
    log.event('Cached app evicted', { flow: 'resolve', served: servedCid, reason });
    if (onScreen) {
      params.reload();
    }
    return onScreen;
  }

  /** Resolves to whether it reloaded the page. */
  async function adopt(cid: string): Promise<boolean> {
    const decision = judgeRedeploy(cid, await params.names.readManifests(label));
    if (decision.kind === 'evict') {
      return drop(decision.reason);
    }
    await params.cache.set({ label, cid: decision.cid, manifests: decision.manifests });
    m.count(S.CACHE_REVALIDATE, { outcome: 'update' });
    log.event('Cached app is outdated', { flow: 'resolve', served: servedCid, latest: cid });
    return false;
  }

  try {
    const found = compareCachedCid(servedCid, await lookUpCid(label, params.names));
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
    params.notify({
      label: 'New version available',
      text: 'This site has been updated. Reload to see the latest version.',
      dismissMs: 0,
      action: {
        label: 'Reload',
        onClick() {
          void adopted.then(
            reloaded => {
              if (!reloaded) {
                params.reload();
              }
            },
            // Reported where it is awaited below.
            () => {
              params.reload();
            },
          );
        },
      },
    });
    await adopted;
  } catch (error: unknown) {
    reportDefect(error, {
      flow: 'resolve',
      step: 'cache_revalidate',
      metric: S.CACHE_REVALIDATE,
      message: '[dot.li] Cached copy revalidation failed:',
      tags: { kind: 'cid_cache_revalidate_error', surface: 'host_cache_revalidate' },
    });
  }
}

/** Timed alone, since the network's answer is what the visitor waits on. */
async function lookUpCid(label: string, names: RevalidateCachedCopyParams['names']): Promise<string | null> {
  const stopTimer = m.timer(S.CACHE_REVALIDATE_LATENCY);
  try {
    // The same lookup the load made, or a product published under its app subname never matches.
    return await names.resolveProduct(label);
  } finally {
    stopTimer();
  }
}
