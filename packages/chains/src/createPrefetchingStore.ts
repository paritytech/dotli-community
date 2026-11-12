// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A chain's stored database is read while the engine's wasm compiles. A blob is megabytes, so an early read is kept
// only until the engine takes it or the light client drops it.

import { markHandled } from '@dotli/shared';
import type { SmoldotDb } from './createSmoldotDb.js';

/** What one read of a chain's stored database found. `unavailable` keeps an outage apart from a cold start. */
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';

type Params = {
  db: SmoldotDb;
  /** Hears what each read the engine makes found. */
  onRead: (genesisHash: string, outcome: SmoldotDbOutcome) => void;
};

/** `db` as the engine reads it, with each chain's read able to start before the engine does. */
export function createPrefetchingStore({ db, onRead }: Params) {
  const reads = new Map<string, Promise<string | null>>();

  return {
    /**
     * The store the engine reads, which takes a chain's early read when one waits. The relay's blob is only read here,
     * never through `loadDatabase`. A failed read rejects rather than reading as empty.
     */
    store: {
      async load(genesisHash) {
        const early = reads.get(genesisHash);
        reads.delete(genesisHash);
        try {
          const blob = await (early ?? db.load(genesisHash));
          onRead(genesisHash, blob !== null ? 'hit' : 'miss');
          return blob;
        } catch (error) {
          onRead(genesisHash, 'unavailable');
          throw error;
        }
      },
      save: (genesisHash, blob) => db.save(genesisHash, blob),
    } satisfies SmoldotDb,
    /** Starts the chain's read now, unless one already waits. Never throws. */
    prefetch(genesisHash: string): void {
      if (!reads.has(genesisHash)) {
        reads.set(genesisHash, markHandled(db.load(genesisHash)));
      }
    },
    /** Drops the chain's early read. Never throws. */
    drop(genesisHash: string): void {
      reads.delete(genesisHash);
    },
    /** Drops every early read but those of `kept`. Never throws. */
    keepOnly(kept: ReadonlySet<string>): void {
      for (const genesisHash of [...reads.keys()]) {
        if (!kept.has(genesisHash)) {
          reads.delete(genesisHash);
        }
      }
    },
  };
}
