// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reports where the sandbox's blocks came from, and trims the block cache once the sandbox is done with it.

import { m, spans as S } from '@dotli/metrics';
import type { SandboxBlockRelay } from '@dotli/bitswap';
import { realTimers, type Timers } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';

export type SandboxContentParams = {
  /** The relay serving the sandbox's blocks. */
  relay: Pick<SandboxBlockRelay, 'onServed'>;
  /** False when the settings skip the archive cache, so there is nothing to count or trim. */
  cached: boolean;
  /** Calls `callback` once, on the sandbox's first outcome. Returns the function that removes it. */
  onSandboxDone: (callback: () => void) => () => void;
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
 * only as `relay.onServed` or `onSandboxDone` does.
 */
export function startSandboxContent({
  relay,
  cached,
  onSandboxDone,
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
  // The page loads one product, so its outcome is waited for the page's life and the removal goes unused.
  onSandboxDone(() => {
    stopCounting();
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
    m.count(S.CACHE_READ, { outcome: misses === 0 ? 'hit' : 'miss', surface: 'block_cache' });
    runWhenIdle(prune);
  });
}
