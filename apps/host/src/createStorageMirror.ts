// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { pageLocalStorage } from '@dotli/shared';
import { parseRecentLabels, serializeRecentLabels } from './parseRecentLabels.js';
import { RECENT_KEY } from './recentKey.js';

/** This origin's copy of the list, kept for when the shared store is unreachable. */
export type RecentMirror = ReturnType<typeof createStorageMirror>;

type Params = {
  /** Where the copy is kept. */
  storage: Pick<Storage, 'getItem' | 'setItem'>;
};

/** Builds this origin's copy of the list in `storage`, kept for when the shared store is unreachable. */
export function createStorageMirror({ storage }: Params) {
  return {
    /** Returns the mirrored list, empty when nothing usable is stored. Throws only as `storage.getItem` does. */
    read: (): string[] => parseRecentLabels(storage.getItem(RECENT_KEY)),
    /** Stores `labels` as the mirrored list. Throws only as `storage.setItem` does. */
    write(labels: string[]): void {
      storage.setItem(RECENT_KEY, serializeRecentLabels(labels));
    },
  };
}

/** The page's mirror, over this origin's localStorage. */
export const pageRecentMirror: RecentMirror = createStorageMirror({ storage: pageLocalStorage });
