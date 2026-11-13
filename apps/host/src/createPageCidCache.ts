// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getNetwork } from '@dotli/config';
import { cidCache, type CachedCid } from '@dotli/storage';
import { showNotification } from '@dotli/ui';
import type { NameSource } from './createNameSource.js';
import { revalidateCachedCopy, type CachedCopy, type ServedCopy } from './revalidateCachedCopy.js';
import { markAndReload } from './createContinuation.js';

export type PageCidCache = ReturnType<typeof createPageCidCache>;

type Params = {
  /** The source the load itself reads, which a check against the network reads too. */
  names: NameSource;
  /** The name the page opens. */
  label: string;
  /** The CID cache read started early for `label`, which serves the first read for it. Never rejects. */
  cidRead: Promise<CachedCid | null>;
  /** Runs `callback` once the page is idle, or after the page's idle timeout. Never throws. */
  runWhenIdle: (callback: () => void) => void;
};

/**
 * The page's CID cache for the active network, checked with `names`, the source the load itself reads. Its first read
 * for the page's name is the early read. Its writes and its check against the network wait until the page is idle,
 * so they never hold a render back.
 */
export function createPageCidCache({ names, label: earlyLabel, cidRead, runWhenIdle }: Params) {
  let early: Promise<CachedCid | null> | null = cidRead;
  const set = ({ label, cid, manifests }: CachedCopy): Promise<void> =>
    cidCache.set({ label, network: getNetwork(), cid, manifests });
  return {
    /** Resolves the label's content, or null when none is kept or the read fails. */
    get(label: string): Promise<CachedCid | null> {
      if (early !== null && label === earlyLabel) {
        const read = early;
        early = null;
        return read;
      }
      return cidCache.get(label, getNetwork());
    },
    /** Keeps the label's content for the next load. */
    storeLater(copy: CachedCopy): void {
      runWhenIdle(() => {
        void set(copy);
      });
    },
    /** Checks a served copy against the network. */
    revalidateLater(copy: ServedCopy): void {
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
