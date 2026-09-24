import { describe, expect, it } from "vitest";
import { createProductOperations } from "@dotli/ui/host-callbacks/ProductOperations";

describe("product operations", () => {
  it("As a worker product, each open operation gets its own id", async () => {
    // Given
    const operations = createProductOperations();
    const product = { productId: "chat.dot" };

    // When
    const first = await operations.beginOperation(product, "send");
    const second = await operations.beginOperation(product, "");
    await operations.endOperation(product, first.id);
    const third = await operations.beginOperation(product, "send");

    // Then
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it("As a worker product, ending an unknown operation succeeds", async () => {
    await expect(
      createProductOperations().endOperation({ productId: "chat.dot" }, 42),
    ).resolves.toBeUndefined();
  });
});
