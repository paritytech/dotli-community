// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getSharedChannel, type SharedChannel } from './runtime/sharedMode.js';
import { createRecentLabels, type RecentLabels } from './createRecentLabels.js';
import type { RecentMirror } from './createStorageMirror.js';

type Params = {
  /** Returns the store every subdomain shares, read on the first use. */
  channel: () => SharedChannel;
  /** This origin's copy, handed to the list. */
  mirror?: RecentMirror | undefined;
};

/**
 * Returns one list for the page, built on first use, so every change on the page queues behind the one before. The
 * returned getter throws only as `channel` does.
 */
export function createLazyRecentLabels({ channel, mirror }: Params): () => RecentLabels {
  let recents: RecentLabels | null = null;

  function getRecentLabels(): RecentLabels {
    recents ??= createRecentLabels({ channel: channel(), mirror });
    return recents;
  }

  return getRecentLabels;
}

const getPageRecentLabels: () => RecentLabels = createLazyRecentLabels({ channel: getSharedChannel });

/** The page's list over its shared store. */
export const recentLabels = {
  /** Returns the page's list store, built on the first call. Never throws. */
  getStore: getPageRecentLabels,
  /** Records a resolved name on the page's list. Rejects as the list's `record` does. */
  record: (label: string): Promise<void> => getPageRecentLabels().record(label),
};
