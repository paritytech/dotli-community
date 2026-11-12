// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every connection of a chain would report the same sync, so one of them holds the chain's tap at a time.

import { getChainRoleForGenesis } from '@dotli/config/fixed';
import type { ChainSyncReporter, ChainSyncTap, ParsedRpcMessage } from './createChainSyncReporter.js';

/** What a chain's sync tap needs of its connection and engine. */
export type ChainSyncSource = Omit<Parameters<ChainSyncReporter['attachChainSync']>[0], 'chain'>;

type Params = {
  attachChainSync: ChainSyncReporter['attachChainSync'];
};

// A chain's connected sources in connect order, and the tap one of them holds.
type ChainSyncEntry = {
  sources: Set<ChainSyncSource>;
  held: { source: ChainSyncSource; tap: ChainSyncTap } | null;
};

/**
 * One sync tap per chain, held by one of its connected sources. When the holder leaves, a source still connected takes
 * the tap, so a chain reports its sync while any connection of it is open. Never throws on its own, since
 * `attachChainSync` never throws. A call throws only what the held tap's `stop` or `intercept` throws.
 */
export function createChainSyncTaps({ attachChainSync }: Params) {
  const entries = new Map<string, ChainSyncEntry>();

  return {
    /** Adds `source` as connected to the chain, which takes the tap when no source holds it. Never throws. */
    join(key: string, source: ChainSyncSource): void {
      const entry = entries.get(key) ?? { sources: new Set(), held: null };
      entries.set(key, entry);
      entry.sources.add(source);
      if (entry.held === null) {
        attach(key, entry, source);
      }
    },
    /**
     * Removes `source`, and when it held the tap, stops it and attaches one to the next source. A repeat does nothing.
     * Throws only what the stopped tap's `stop` throws, and never from the attach.
     */
    leave(key: string, source: ChainSyncSource): void {
      const entry = entries.get(key);
      if (entry?.sources.delete(source) !== true) {
        return;
      }
      if (entry.sources.size === 0) {
        entries.delete(key);
      }
      if (entry.held?.source !== source) {
        return;
      }
      entry.held.tap.stop();
      entry.held = null;
      const [next] = entry.sources;
      if (next !== undefined) {
        attach(key, entry, next);
      }
    },
    /** Whether `parsed` was the tap's own reply, true only on the source that holds the tap. Throws what the tap throws. */
    intercept(key: string, source: ChainSyncSource, parsed: ParsedRpcMessage): boolean {
      const held = entries.get(key)?.held;
      return held?.source === source && held.tap.intercept(parsed);
    },
  };

  function attach(key: string, entry: ChainSyncEntry, source: ChainSyncSource): void {
    const chain = getChainRoleForGenesis(key);
    if (chain === null) {
      return;
    }
    const tap = attachChainSync({ chain, ...source });
    if (tap !== null) {
      entry.held = { source, tap };
    }
  }
}
