import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPreimageAdapters } from "@dotli/ui/host-callbacks/Preimage";
import { computePreimageKey } from "@dotli/content/preimage";
import { fromHex } from "@dotli/shared/hex";

const mocks = vi.hoisted(() => ({
  fetchFromIpfs: vi.fn(async () => ({ data: new Uint8Array() })),
  bitswapGet: vi.fn(async () => new Uint8Array()),
  getBackend: vi.fn(() => "rpc-gateway"),
}));

vi.mock("@dotli/content/ipfs", () => ({
  fetchFromIpfs: mocks.fetchFromIpfs,
}));

vi.mock("@dotli/ui/bulletin-bitswap", () => ({
  bitswapGet: mocks.bitswapGet,
}));

vi.mock("@dotli/config/mode", () => ({
  getBackend: mocks.getBackend,
}));

describe("preimage host callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchFromIpfs.mockResolvedValue({ data: new Uint8Array() });
    mocks.bitswapGet.mockResolvedValue(new Uint8Array());
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

  it("emits lookup backend failures as stream errors", async () => {
    vi.useFakeTimers();
    try {
      const { lookupPreimage } = createPreimageAdapters("myapp");
      const missingKey = new Uint8Array(32);
      mocks.fetchFromIpfs.mockRejectedValueOnce(
        new Error("gateway unavailable"),
      );

      const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
      const first = await iterator.next();
      const secondPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(1000);
      const second = await secondPromise;
      const done = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value.isOk()).toBe(true);
      expect(first.value._unsafeUnwrap()).toBeUndefined();
      expect(second.done).toBe(false);
      expect(second.value.isErr()).toBe(true);
      expect(second.value._unsafeUnwrapErr().reason).toContain(
        "preimage lookup via rpc-gateway failed: gateway unavailable",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);
      expect(done.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a gateway preimage only after hash verification", async () => {
    vi.useFakeTimers();
    try {
      const data = new TextEncoder().encode("verified gateway preimage");
      const key = fromHex(computePreimageKey(data));
      mocks.fetchFromIpfs.mockResolvedValue({ data });
      const { lookupPreimage } = createPreimageAdapters("myapp");

      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      await iterator.next();
      const foundPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(1000);
      const found = await foundPromise;
      await iterator.return?.();

      expect(found.done).toBe(false);
      expect(found.value.isOk()).toBe(true);
      expect(found.value._unsafeUnwrap()).toEqual(data);

      const cached = await lookupPreimage(key)[Symbol.asyncIterator]().next();
      expect(cached.done).toBe(false);
      expect(cached.value.isOk()).toBe(true);
      expect(cached.value._unsafeUnwrap()).toEqual(data);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["rpc-gateway", "smoldot-direct"] as const)(
    "rejects and does not cache corrupt data from %s",
    async (backend) => {
      vi.useFakeTimers();
      try {
        const expected = new TextEncoder().encode(
          `expected preimage from ${backend}`,
        );
        const corrupt = new TextEncoder().encode("corrupt preimage");
        const key = fromHex(computePreimageKey(expected));
        mocks.getBackend.mockReturnValue(backend);
        mocks.fetchFromIpfs.mockResolvedValue({ data: corrupt });
        mocks.bitswapGet.mockResolvedValue(corrupt);
        const { lookupPreimage } = createPreimageAdapters("myapp");

        const firstIterator = lookupPreimage(key)[Symbol.asyncIterator]();
        await firstIterator.next();
        const firstErrorPromise = firstIterator.next();
        await vi.advanceTimersByTimeAsync(1000);
        const firstError = await firstErrorPromise;

        expect(firstError.done).toBe(false);
        expect(firstError.value.isErr()).toBe(true);
        expect(firstError.value._unsafeUnwrapErr().reason).toContain(
          "Content hash mismatch",
        );

        const secondIterator = lookupPreimage(key)[Symbol.asyncIterator]();
        const secondMiss = await secondIterator.next();
        const secondErrorPromise = secondIterator.next();
        await vi.advanceTimersByTimeAsync(1000);
        const secondError = await secondErrorPromise;

        expect(secondMiss.value._unsafeUnwrap()).toBeUndefined();
        expect(secondError.value.isErr()).toBe(true);
        const fetch =
          backend === "rpc-gateway" ? mocks.fetchFromIpfs : mocks.bitswapGet;
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
