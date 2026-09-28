// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chains the network popover watches, reached over the host's remote
// chain provider. Eager and Solid-free: initTopBar hands it to the network
// monitor at boot (setBlockSource), before the islands chunk loads.

import { log } from "@dotli/shared/log";
import {
  createRemoteChainProvider,
  isRemoteChainConnectable,
} from "@dotli/protocol/client";
import type { BlockSource } from "./network-monitor";

/**
 * Watch the best block of each chain over a client held for the session.
 *
 * One client per chain, held open, pays for metadata once. `bestBlocks$` then
 * reports every head change rather than whatever a poll happens to catch.
 */
export function createBlockSource(): BlockSource {
  return {
    isReachable: (genesis) => isRemoteChainConnectable(genesis),
    subscribe: (genesis, onBlock) => {
      // A record rather than two locals: the returned unsubscribe runs after
      // this function has gone, and a plain boolean flipped from there cannot
      // be seen by the checker.
      const live = { cancelled: false, teardown: null as (() => void) | null };
      void (async () => {
        try {
          const provider = createRemoteChainProvider(genesis);
          if (provider === null) {
            return;
          }
          const papi = await import("polkadot-api");
          const client = papi.createClient(provider);
          if (live.cancelled) {
            client.destroy();
            return;
          }
          const sub = client.bestBlocks$.subscribe({
            next: (blocks) => {
              const best = blocks.at(0);
              if (best !== undefined) {
                onBlock(best.number);
              }
            },
            error: (err: unknown) => {
              // A dropped chain renders as a gap in its strip, which is the
              // truth, so this is worth a log line and nothing louder.
              log.warn(
                `[dot.li network] block stream for ${genesis.slice(0, 10)} ended: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          });
          live.teardown = () => {
            sub.unsubscribe();
            client.destroy();
          };
        } catch (err: unknown) {
          log.warn(
            `[dot.li network] cannot watch ${genesis.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      return () => {
        live.cancelled = true;
        live.teardown?.();
      };
    },
  };
}
