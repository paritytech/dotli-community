// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chains the network popover watches, reached over the host's remote
// chain provider. Eager and Solid-free: initTopBar hands it to the network
// monitor at boot (setBlockSource), whenever the shell's islands hydrate.

import { log } from '@dotli/shared';
import {
  createRemoteChainProvider,
  isProtocolReady,
  isRemoteChainConnectable,
  onProtocolReady,
  type RemoteChainHalt,
} from '@dotli/protocol';
import type { BlockSource } from './network-monitor.js';

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Watch the best block of each chain over a client held for the session.
 *
 * One client per chain, held open, pays for metadata once. `bestBlocks$` then
 * reports every head change rather than whatever a poll happens to catch.
 *
 * When the chain halts the client is destroyed and a new one is dialled after
 * a doubling wait, reset by a block. When the protocol frame dies, before the
 * halt or during that wait, there is nothing to dial until it reports ready
 * again, so the bar waits for that.
 */
export function createBlockSource(): BlockSource {
  return {
    isReachable: genesis => isRemoteChainConnectable(genesis),
    subscribe: (genesis, onBlock) => {
      // A record rather than locals: the returned unsubscribe runs after this
      // function has gone, and a plain boolean flipped from there cannot be
      // seen by the checker.
      const live = {
        cancelled: false,
        delay: FIRST_RETRY_MS,
        teardown: null as (() => void) | null,
        timer: null as ReturnType<typeof setTimeout> | null,
        unready: null as (() => void) | null,
      };
      const short = genesis.slice(0, 10);

      const clearWaiting = (): void => {
        if (live.timer !== null) {
          clearTimeout(live.timer);
          live.timer = null;
        }
        live.unready?.();
        live.unready = null;
      };

      // Dialling without a frame would boot one, which a bar never does on its own.
      const awaitFrame = (): void => {
        live.unready = onProtocolReady(() => {
          clearWaiting();
          void connect();
        });
      };

      const connect = async (): Promise<void> => {
        try {
          const remote = createRemoteChainProvider(genesis);
          if (remote === null) {
            return;
          }
          const papi = await import('polkadot-api');
          if (live.cancelled) {
            return;
          }
          // Per connection, so a halt of a client already replaced is ignored.
          const mine = { done: false };
          const release = (): void => {
            mine.done = true;
            live.teardown = null;
          };
          const onHalt = (reason: RemoteChainHalt): void => {
            if (mine.done || live.cancelled) {
              return;
            }
            live.teardown?.();
            clearWaiting();
            if (reason === 'frame') {
              awaitFrame();
              return;
            }
            const wait = live.delay;
            live.delay = Math.min(live.delay * 2, MAX_RETRY_MS);
            live.timer = setTimeout(() => {
              live.timer = null;
              if (live.cancelled) {
                return;
              }
              // A frame that died during the wait told only the connections
              // it had, and dialling now would boot a new one.
              if (isProtocolReady()) {
                void connect();
              } else {
                awaitFrame();
              }
            }, wait);
          };
          const client = papi.createClient(onMessage => remote(onMessage, onHalt));
          const sub = client.bestBlocks$.subscribe({
            next: blocks => {
              const best = blocks.at(0);
              if (best !== undefined) {
                live.delay = FIRST_RETRY_MS;
                onBlock(best.number);
              }
            },
            error: (err: unknown) => {
              // A dropped chain renders as a gap in its strip, which is the
              // truth, so this is worth a log line and nothing louder.
              log.warn(
                `[dot.li network] block stream for ${short} ended: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          });
          live.teardown = () => {
            release();
            sub.unsubscribe();
            client.destroy();
          };
        } catch (err: unknown) {
          log.warn(`[dot.li network] cannot watch ${short}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      void connect();
      return () => {
        live.cancelled = true;
        clearWaiting();
        live.teardown?.();
      };
    },
  };
}
