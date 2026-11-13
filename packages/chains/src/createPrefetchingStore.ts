// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A chain's stored database is read while the engine's wasm compiles. A blob is megabytes, so an early read is kept
// only until the engine takes it or the light client drops it.

import { getChainRoleForGenesis, type ChainRole } from '@dotli/config/fixed';
import { markHandled } from '@dotli/shared';
import type { SmoldotDb } from './createSmoldotDb.js';

/** What one read of a chain's stored database found. `unavailable` keeps an outage apart from a cold start. */
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';

// Observed at the store, since the crate reads it for the relay it dials internally. People is left out, as nothing the
// page waits on depends on it.
export type SmoldotDbChain = Exclude<ChainRole, 'people'>;

type Params = {
  db: SmoldotDb;
  /** Hears each chain's first read. */
  onFirstRead: (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void;
};

/** `db` as the engine reads it, with each chain's read able to start before the engine does. */
export function createPrefetchingStore({ db, onFirstRead }: Params) {
  const reads = new Map<string, Promise<string | null>>();
  // First read wins, since only the chain's first add consumes the store.
  const firstReads = new Map<SmoldotDbChain, SmoldotDbOutcome>();

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
          noteRead(genesisHash, blob !== null ? 'hit' : 'miss');
          return blob;
        } catch (error) {
          noteRead(genesisHash, 'unavailable');
          throw error;
        }
      },
      save: (genesisHash, blob) => db.save(genesisHash, blob),
    } satisfies SmoldotDb,
    /** Each chain's first read, as a copy. Never throws. */
    getFirstReads(): Map<SmoldotDbChain, SmoldotDbOutcome> {
      return new Map(firstReads);
    },
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

  function noteRead(genesisHash: string, outcome: SmoldotDbOutcome): void {
    const chain = getChainRoleForGenesis(genesisHash);
    if (chain === null || chain === 'people' || firstReads.has(chain)) {
      return;
    }
    firstReads.set(chain, outcome);
    onFirstRead(chain, outcome);
  }
}
