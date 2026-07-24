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

  it("As a dotli integrator, the host emits a miss immediately for an uncached lookup", async () => {
    // Given
    const { lookupPreimage } = createPreimageAdapters("myapp");
    const missingKey = new Uint8Array(32);

    // When
    const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    // Then
    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toBeUndefined();
  });

  it("As a dotli integrator, the host retries transient lookup backend failures", async () => {
    // Given
    vi.useFakeTimers();
    try {
      const { lookupPreimage } = createPreimageAdapters("myapp");
      const missingKey = new Uint8Array(32);
      mocks.fetchFromIpfs.mockRejectedValueOnce(
        new Error("gateway unavailable"),
      );

      // When
      const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
      const first = await iterator.next();
      await vi.advanceTimersByTimeAsync(1000);

      // Then
      expect(first.done).toBe(false);
      expect(first.value.isOk()).toBe(true);
      expect(first.value._unsafeUnwrap()).toBeUndefined();
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);

      // When
      await vi.advanceTimersByTimeAsync(9_000);

      // Then
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(2);
      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a dotli integrator, the host caches a gateway preimage only after hash verification", async () => {
    // Given
    vi.useFakeTimers();
    try {
      const data = new TextEncoder().encode("verified gateway preimage");
      const key = fromHex(computePreimageKey(data));
      mocks.fetchFromIpfs.mockResolvedValue({ data });
      const { lookupPreimage } = createPreimageAdapters("myapp");

      // When
      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      await iterator.next();
      const foundPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(1000);
      const found = await foundPromise;
      await iterator.return?.();

      // Then
      expect(found.done).toBe(false);
      expect(found.value.isOk()).toBe(true);
      expect(found.value._unsafeUnwrap()).toEqual(data);

      // When
      const cached = await lookupPreimage(key)[Symbol.asyncIterator]().next();

      // Then
      expect(cached.done).toBe(false);
      expect(cached.value.isOk()).toBe(true);
      expect(cached.value._unsafeUnwrap()).toEqual(data);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["rpc-gateway", "smoldot-direct"] as const)(
    "As a product, the host rejects and does not cache corrupt data from %s",
    async (backend) => {
      // Given
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

        // When
        const firstIterator = lookupPreimage(key)[Symbol.asyncIterator]();
        await firstIterator.next();
        const firstErrorPromise = firstIterator.next();
        await vi.advanceTimersByTimeAsync(1000);
        const firstError = await firstErrorPromise;

        // Then
        expect(firstError.done).toBe(false);
        expect(firstError.value.isErr()).toBe(true);
        expect(firstError.value._unsafeUnwrapErr().reason).toContain(
          "Content hash mismatch",
        );

        // When
        const secondIterator = lookupPreimage(key)[Symbol.asyncIterator]();
        const secondMiss = await secondIterator.next();
        const secondErrorPromise = secondIterator.next();
        await vi.advanceTimersByTimeAsync(1000);
        const secondError = await secondErrorPromise;

        // Then
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
