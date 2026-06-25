import { describe, expect, it, vi } from "vitest";
import { createPreimageAdapters } from "@dotli/ui/host-callbacks/Preimage";
import { submitPreimageRemote } from "@dotli/protocol/client";

vi.mock("@dotli/protocol/client", () => ({
  submitPreimageRemote: vi.fn(async () => undefined),
}));

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

  it("emits a cached preimage immediately after submit", async () => {
    const { submitPreimage, lookupPreimage } = createPreimageAdapters("myapp");
    const preimage = new Uint8Array([1, 2, 3, 4]);

    const key = await submitPreimage(preimage);

    expect(submitPreimageRemote).toHaveBeenCalledWith(preimage);

    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(Array.from(first.value._unsafeUnwrap() ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
