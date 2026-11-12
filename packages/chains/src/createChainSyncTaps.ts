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

// A chain's connected sources in connect order, by connection, and the connection whose source holds the tap.
type ChainSyncEntry = {
  sources: Map<symbol, ChainSyncSource>;
  held: { connection: symbol; tap: ChainSyncTap } | null;
};

/**
 * One sync tap per chain, held by one of its connections. When the holder leaves, a connection still open takes the
 * tap, so a chain reports its sync while any connection of it is open. Each `connection` is unique to one connection.
 * Never throws on its own, since `attachChainSync` never throws. A call throws only what the held tap's `stop` or
 * `intercept` throws.
 */
export function createChainSyncTaps({ attachChainSync }: Params) {
  const entries = new Map<string, ChainSyncEntry>();

  return {
    /** Adds the connection with its source, which takes the tap when no connection holds it. Never throws. */
    join(genesis: string, connection: symbol, source: ChainSyncSource): void {
      const entry = entries.get(genesis) ?? { sources: new Map(), held: null };
      entries.set(genesis, entry);
      entry.sources.set(connection, source);
      if (entry.held === null) {
        attach(genesis, entry, [connection, source]);
      }
    },
    /**
     * Removes the connection, and when it held the tap, stops it and attaches one to the next connection. A repeat does
     * nothing. Throws only what the stopped tap's `stop` throws, and never from the attach.
     */
    leave(genesis: string, connection: symbol): void {
      const entry = entries.get(genesis);
      if (entry?.sources.delete(connection) !== true) {
        return;
      }
      if (entry.sources.size === 0) {
        entries.delete(genesis);
      }
      if (entry.held?.connection !== connection) {
        return;
      }
      entry.held.tap.stop();
      entry.held = null;
      const [next] = entry.sources;
      if (next !== undefined) {
        attach(genesis, entry, next);
      }
    },
    /**
     * Whether `parsed` was the tap's own reply, true only on the connection that holds the tap. Throws what the tap
     * throws.
     */
    intercept(genesis: string, connection: symbol, parsed: ParsedRpcMessage): boolean {
      const held = entries.get(genesis)?.held;
      return held?.connection === connection && held.tap.intercept(parsed);
    },
  };

  function attach(genesis: string, entry: ChainSyncEntry, [connection, source]: [symbol, ChainSyncSource]): void {
    const chain = getChainRoleForGenesis(genesis);
    if (chain === null) {
      return;
    }
    const tap = attachChainSync({ chain, ...source });
    if (tap !== null) {
      entry.held = { connection, tap };
    }
  }
}
