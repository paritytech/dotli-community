// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chains the network popover watches, reached over the host's remote
// chain provider. Eager and Solid-free: initTopBar hands it to the network
// monitor at boot (setBlockSource), whenever the shell's islands hydrate. The
// watch itself (`block-watch.ts`) loads with polkadot-api on first subscribe.

import { log } from '@dotli/shared';
import { isRemoteChainConnectable } from '@dotli/protocol';
import type { BlockSource } from './network-monitor.js';

export function createBlockSource(): BlockSource {
  return {
    isReachable: genesis => isRemoteChainConnectable(genesis),
    subscribe: (genesis, onBlock) => {
      // A record rather than locals: the returned unsubscribe runs after this
      // function has gone, and a plain boolean flipped from there cannot be
      // seen by the checker.
      const live = { cancelled: false, stop: null as (() => void) | null };
      import('./block-watch.js').then(
        ({ watchBlocks }) => {
          if (!live.cancelled) {
            live.stop = watchBlocks(genesis, onBlock);
          }
        },
        (err: unknown) => {
          log.warn(`[dot.li network] cannot watch ${genesis.slice(0, 10)}:`, err);
        },
      );
      return () => {
        live.cancelled = true;
        live.stop?.();
      };
    },
  };
}
