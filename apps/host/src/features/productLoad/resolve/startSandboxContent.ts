// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reports where the sandbox's blocks came from, and trims the block cache once the sandbox is done with it.

import type { SandboxBlockRelay } from '@dotli/bitswap';
import { realTimers, type Timers } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { cacheReadMetric } from './cacheReadMetric.js';
import type { SandboxLoad } from './watchSandboxLoad.js';

export type SandboxContentParams = {
  /** The relay serving the sandbox's blocks. */
  relay: Pick<SandboxBlockRelay, 'onServed'>;
  /** False when the settings skip the archive cache, so there is nothing to count or trim. */
  cached: boolean;
  /** Hears the sandbox's outcomes, the latest at once. */
  subscribeOutcomes: SandboxLoad['subscribeOutcomes'];
  /** Trims the block cache to its size budget. */
  prune: () => void;
  /** Runs `callback` once the page is idle. */
  runWhenIdle: (callback: () => void) => void;
  /** Sends `event` to the debug panel. */
  emit: (event: DotliDebugEvent) => void;
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** The wall clock the debug event is stamped with. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
};

/**
 * Counts the sandbox's block sources until its first outcome, then reports them and trims the cache when idle. Throws
 * only as `relay.onServed` does. A throw once the outcome came goes to the outcome's subscription.
 */
export function startSandboxContent({
  relay,
  cached,
  subscribeOutcomes,
  prune,
  runWhenIdle,
  emit,
  flowId,
  timers = realTimers,
}: SandboxContentParams): void {
  if (!cached) {
    return;
  }
  const blocksServed = { cache: 0, network: 0 };
  const stopCounting = relay.onServed(from => {
    blocksServed[from] += 1;
  });
  const subscription: { heard: boolean; stop: (() => void) | null } = { heard: false, stop: null };
  subscription.stop = subscribeOutcomes(() => {
    subscription.heard = true;
    stopCounting();
    // An outcome heard at once comes before the subscribe returns, so the check below stops it.
    subscription.stop?.();
    const { cache: hits, network: misses } = blocksServed;
    if (hits + misses === 0) {
      return;
    }
    emit({
      layer: 'boot',
      event: 'block_cache',
      flowId,
      timestamp: timers.now(),
      payload: { hits, misses },
    });
    cacheReadMetric.count({ outcome: misses === 0 ? 'hit' : 'miss', surface: 'block_cache' });
    runWhenIdle(prune);
  });
  if (subscription.heard) {
    subscription.stop();
  }
}
