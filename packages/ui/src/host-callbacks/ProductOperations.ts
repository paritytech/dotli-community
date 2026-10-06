import type { ProductOperations } from "@parity/truapi-host";

export function createProductOperations(): ProductOperations {
  let nextId = 0;
  return {
    beginOperation() {
      const id = nextId;
      nextId = (nextId + 1) >>> 0;
      return Promise.resolve({ id });
    },
    endOperation() {
      return Promise.resolve();
    },
  };
}
