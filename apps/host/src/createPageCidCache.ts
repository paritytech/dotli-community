// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getNetwork } from '@dotli/config';
import { cidCache } from '@dotli/storage';
import { showNotification } from '@dotli/ui';
import type { CachedCopy, LoaderCidCache } from './createProductLoader.js';
import type { NameSource } from './createNameSource.js';
import { revalidateCachedCopy } from './revalidateCachedCopy.js';
import { markAndReload } from './createContinuation.js';

/** A CID cache read started before the shell was up, for the name the page opens. */
export type EarlyCidRead = { label: string; read: ReturnType<LoaderCidCache['get']> };

type Params = {
  /** The source the load itself reads, which a check against the network reads too. */
  names: NameSource;
  /** The early read, which serves the first read for its name. */
  cidRead: EarlyCidRead | null;
  /** Runs `callback` once the page is idle, or after the page's idle timeout. Never throws. */
  runWhenIdle: (callback: () => void) => void;
};

/**
 * The page's CID cache for the active network, checked with `names`, the source the load itself reads. Its first read
 * for the early read's name is that read. Its writes and its check against the network wait until the page is idle,
 * so they never hold a render back.
 */
export function createPageCidCache({ names, cidRead, runWhenIdle }: Params): LoaderCidCache {
  let early = cidRead;
  const set = ({ label, cid, manifests }: CachedCopy): Promise<void> =>
    cidCache.set({ label, network: getNetwork(), cid, manifests });
  return {
    get(label) {
      if (early?.label === label) {
        const { read } = early;
        early = null;
        return read;
      }
      return cidCache.get(label, getNetwork());
    },
    storeLater(copy) {
      runWhenIdle(() => {
        void set(copy);
      });
    },
    revalidateLater(copy) {
      runWhenIdle(() => {
        void revalidateCachedCopy({
          ...copy,
          names,
          cache: { set, evict: cidCache.evict },
          notify: showNotification,
          reload() {
            markAndReload('app_update');
          },
        });
      });
    },
  };
}
