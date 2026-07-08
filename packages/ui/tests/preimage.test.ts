import { describe, expect, it } from "vitest";
import { createPreimageAdapters } from "@dotli/ui/host-callbacks/Preimage";

describe("preimage host callbacks", () => {
  it("emits a miss immediately for an uncached lookup", async () => {
    const { lookupPreimage } = createPreimageAdapters("myapp");
    const missingKey = new Uint8Array(32);

    const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toBeUndefined();
  });

  it("only exposes the lookup callback (submission is core-owned)", () => {
    const adapters = createPreimageAdapters("myapp");
    expect(typeof adapters.lookupPreimage).toBe("function");
    expect("submitPreimage" in adapters).toBe(false);
  });
});
