// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One chain's best-block watch for the network popover. Loaded with polkadot-api on first subscribe.

import { createClient } from 'polkadot-api';
import { getBackend } from '@dotli/config';
import { log } from '@dotli/shared';
import { isProtocolReady, onProtocolReady, type RemoteChainHalt } from '@dotli/protocol';
import { hostChainProvider } from './host-callbacks/Chain.js';

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Watches one chain's best block over a client held for the session, so metadata is paid once.
 *
 * A halt redials after a doubling wait that a block resets. On the smoldot backends a dead protocol frame
 * means waiting for it to report ready again, since dialling would boot a new one.
 */
export function watchBlocks(genesis: string, onBlock: (blockNumber: number) => void): () => void {
  // A record, not locals, so the checker sees the flag the returned stop flips.
  const live = {
    cancelled: false,
    delay: FIRST_RETRY_MS,
    teardown: null as (() => void) | null,
    timer: null as ReturnType<typeof setTimeout> | null,
    unready: null as (() => void) | null,
  };
  const short = genesis.slice(0, 10);
  // Read once: every backend switch reloads the page.
  const viaFrame = getBackend() !== 'rpc-gateway';

  const clearWaiting = (): void => {
    if (live.timer !== null) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    live.unready?.();
    live.unready = null;
  };

  // Dialling without a frame would boot one, which a watch never does on its own.
  const awaitFrame = (): void => {
    live.unready = onProtocolReady(() => {
      clearWaiting();
      connect();
    });
  };

  const connect = (): void => {
    try {
      const remote = hostChainProvider(genesis);
      if (remote === null) {
        return;
      }
      // Per connection, so a halt of a client already replaced is ignored.
      const mine = { done: false };
      const onHalt = (reason: RemoteChainHalt): void => {
        if (mine.done || live.cancelled) {
          return;
        }
        live.teardown?.();
        clearWaiting();
        if (reason === 'frame' && viaFrame) {
          awaitFrame();
          return;
        }
        const wait = live.delay;
        live.delay = Math.min(live.delay * 2, MAX_RETRY_MS);
        live.timer = setTimeout(() => {
          live.timer = null;
          // A frame that died during the wait told no one, and dialling now would boot a new one.
          if (!viaFrame || isProtocolReady()) {
            connect();
          } else {
            awaitFrame();
          }
        }, wait);
      };
      const client = createClient(onMessage => remote(onMessage, onHalt));
      const sub = client.bestBlocks$.subscribe({
        next: blocks => {
          const best = blocks.at(0);
          if (best !== undefined) {
            live.delay = FIRST_RETRY_MS;
            onBlock(best.number);
          }
        },
        error: (err: unknown) => {
          log.warn(`[dot.li network] block stream for ${short} ended:`, err);
        },
      });
      live.teardown = () => {
        mine.done = true;
        live.teardown = null;
        sub.unsubscribe();
        client.destroy();
      };
    } catch (err: unknown) {
      log.warn(`[dot.li network] cannot watch ${short}:`, err);
    }
  };

  connect();
  return () => {
    live.cancelled = true;
    clearWaiting();
    live.teardown?.();
  };
}
