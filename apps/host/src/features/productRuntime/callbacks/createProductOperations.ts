// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An id lives only while its operation is open, so one counter per instance keeps the open ids unique.
// The core's runtime never ends the operations still open when it tears down or faults, so the core's end lets go too.

import type { ProductOperations } from '@parity/truapi-host';
import { networkPause, type NetworkPause } from '../../network/index.js';
import type { CoreContext } from '../core/createPageCore.js';

type Params = {
  /** The core whose worker opens the operations. */
  core: Pick<CoreContext, 'ended'>;
  /** Keeps the network awake while an operation is open. */
  holdNetwork?: NetworkPause['hold'];
};

/**
 * Hands out operation ids, each unique among the open operations, and keeps the network awake while one is open and the
 * core lives. Ending an id that is not open does nothing. Neither member rejects.
 */
export function createProductOperations({
  core,
  holdNetwork = networkPause.hold,
}: Params): Required<ProductOperations> {
  let nextId = 0;
  const open = new Set<number>();
  let release: (() => void) | null = null;
  core.ended.addEventListener('abort', () => {
    open.clear();
    letGo();
  });

  return {
    beginOperation() {
      const id = nextId++;
      if (!core.ended.aborted) {
        open.add(id);
        release ??= holdNetwork();
      }
      return Promise.resolve({ id });
    },
    endOperation(_product, id) {
      open.delete(id);
      if (open.size === 0) {
        letGo();
      }
      return Promise.resolve();
    },
  };

  function letGo(): void {
    release?.();
    release = null;
  }
}
