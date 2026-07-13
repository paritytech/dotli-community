import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPreimageAdapters } from "@dotli/ui/host-callbacks/Preimage";

const mocks = vi.hoisted(() => ({
  fetchFromIpfs: vi.fn(async () => ({ data: new Uint8Array() })),
  getBackend: vi.fn(() => "rpc-gateway"),
}));

vi.mock("@dotli/content/ipfs", () => ({
  fetchFromIpfs: mocks.fetchFromIpfs,
}));

vi.mock("@dotli/config/mode", () => ({
  getBackend: mocks.getBackend,
}));

describe("preimage host callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchFromIpfs.mockResolvedValue({ data: new Uint8Array() });
    mocks.getBackend.mockReturnValue("rpc-gateway");
  });

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

  it("keeps polling after transient lookup backend failures", async () => {
    vi.useFakeTimers();
    try {
      const { lookupPreimage } = createPreimageAdapters("myapp");
      const missingKey = new Uint8Array(32);
      const found = new Uint8Array([1, 2, 3]);
      mocks.fetchFromIpfs.mockRejectedValueOnce(
        new Error("gateway unavailable"),
      );
      mocks.fetchFromIpfs.mockResolvedValueOnce({ data: found });

      const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
      const first = await iterator.next();
      const secondPromise = iterator.next();
      let secondSettled = false;
      void secondPromise.then(() => {
        secondSettled = true;
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(first.done).toBe(false);
      expect(first.value.isOk()).toBe(true);
      expect(first.value._unsafeUnwrap()).toBeUndefined();
      expect(secondSettled).toBe(false);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9000);
      const second = await secondPromise;
      expect(second.done).toBe(false);
      expect(second.value.isOk()).toBe(true);
      expect(second.value._unsafeUnwrap()).toEqual(found);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(2);
      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
