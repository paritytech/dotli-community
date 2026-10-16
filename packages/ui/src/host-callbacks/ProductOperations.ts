// The core and worker runtime keep the worker alive while an operation is open, so
// ids only need to be unique among open operations, which one global counter is.

import type { ProductOperations } from '@parity/truapi-host';

export function createProductOperations(): Required<ProductOperations> {
  let nextId = 0;
  return {
    beginOperation: () => Promise.resolve({ id: nextId++ }),
    // Nothing to release host-side.
    endOperation: () => Promise.resolve(),
  };
}
