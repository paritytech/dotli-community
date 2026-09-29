import { describe, expect, it } from "vitest";
import type { ProductContext } from "@parity/truapi-host";
import { createProductOperations } from "../src/host-callbacks/ProductOperations.js";

// Operations belong to Worker executions.
const PRODUCT: ProductContext = {
  productId: "chat.dot",
  executionKind: "Worker",
};

describe("product operations", () => {
  it("As a worker product, each open operation gets its own id", async () => {
    // Given
    const operations = createProductOperations();

    // When
    const first = await operations.beginOperation(PRODUCT, "send");
    const second = await operations.beginOperation(PRODUCT, "");
    await operations.endOperation(PRODUCT, first.id);
    const third = await operations.beginOperation(PRODUCT, "send");

    // Then
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it("As a worker product, ending an unknown operation succeeds", async () => {
    await expect(
      createProductOperations().endOperation(PRODUCT, 42),
    ).resolves.toBeUndefined();
  });
});
