// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An id lives only while its operation is open, so one counter per instance keeps the open ids unique.

import type { ProductOperations } from '@parity/truapi-host';

/** Hands out operation ids, each unique among the open operations. Neither member rejects. */
export function createProductOperations(): Required<ProductOperations> {
  let nextId = 0;
  return {
    beginOperation: () => Promise.resolve({ id: nextId++ }),
    // Nothing to release host-side.
    endOperation: () => Promise.resolve(),
  };
}
