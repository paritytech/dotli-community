// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reports where the sandbox's blocks came from, and trims the block cache once the sandbox is done with it.

import { m, spans as S } from '@dotli/metrics';
import type { SandboxBlockRelay } from '@dotli/bitswap';
import type { DotliDebugEvent } from '@dotli/truapi-debug';

export interface SandboxContentDeps {
  /** The relay serving the sandbox's blocks. */
  relay: Pick<SandboxBlockRelay, 'onServed'>;
  /** False when the settings skip the archive cache, so there is nothing to count or trim. */
  cached: boolean;
  /** Called once, on the sandbox's first outcome. */
  onSandboxDone: (callback: () => void) => void;
  /** Trims the block cache to its size budget. */
  prune: () => void;
  idle: (callback: () => void) => void;
  emit: (event: DotliDebugEvent) => void;
  flowId: string;
}

export function startSandboxContent(deps: SandboxContentDeps): void {
  if (!deps.cached) {
    return;
  }
  const blocksServed = { cache: 0, network: 0 };
  const stopCounting = deps.relay.onServed(from => {
    blocksServed[from] += 1;
  });
  deps.onSandboxDone(() => {
    stopCounting();
    const { cache: hits, network: misses } = blocksServed;
    if (hits + misses === 0) {
      return;
    }
    deps.emit({
      layer: 'boot',
      event: 'block_cache',
      flowId: deps.flowId,
      timestamp: Date.now(),
      payload: { hits, misses },
    });
    m.count(S.CACHE_READ, { outcome: misses === 0 ? 'hit' : 'miss', surface: 'block_cache' });
    deps.idle(deps.prune);
  });
}
