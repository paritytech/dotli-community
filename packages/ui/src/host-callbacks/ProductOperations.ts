// Pending-operation ids for Worker executions. The core and the worker host
// runtime hold the worker alive while an operation is open, so the host only
// has to hand out ids unique among a product's open operations. One counter
// never repeats an id, which satisfies that for every product at once.

import type { ProductOperations } from "@parity/truapi-host";

export function createProductOperations(): Required<ProductOperations> {
  let nextId = 0;
  return {
    beginOperation: () => Promise.resolve({ id: nextId++ }),
    // Idempotent by contract, and there is nothing to release host-side.
    endOperation: () => Promise.resolve(),
  };
}
