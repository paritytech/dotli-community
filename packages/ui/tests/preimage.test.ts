import { computePreimageKey } from "@dotli/content/preimage";
import { fromHex } from "@dotli/shared/hex";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPreimageAdapters } from "@dotli/ui/host-callbacks/Preimage";

const mocks = vi.hoisted(() => ({
  getPolkadotSigner: vi.fn(
    (
      publicKey: Uint8Array,
      type: string,
      sign: (input: Uint8Array) => Promise<Uint8Array> | Uint8Array,
    ) => ({ publicKey, type, sign }),
  ),
  submitPreimageAsUser: vi.fn(async () => undefined),
}));

vi.mock("polkadot-api/signer", () => ({
  getPolkadotSigner: mocks.getPolkadotSigner,
}));

vi.mock("@dotli/ui/preimage-submit", () => ({
  submitPreimageAsUser: mocks.submitPreimageAsUser,
}));

describe("preimage host callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submitPreimageAsUser.mockResolvedValue(undefined);
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

  it("submits with the bulletin allowance signer and caches the preimage", async () => {
    const { lookupPreimage, submitPreimage } = createPreimageAdapters("myapp");
    const value = new Uint8Array([1, 2, 3, 4]);
    const publicKey = new Uint8Array(32);
    publicKey.fill(7);
    const allowanceSigner = {
      publicKey,
      sign: vi.fn(async (input: Uint8Array) => {
        const signature = new Uint8Array(input.length + 1);
        signature.set(input);
        signature[signature.length - 1] = 42;
        return signature;
      }),
    };

    const key = await submitPreimage(value, allowanceSigner);

    const expectedKey = fromHex(computePreimageKey(value));
    expect(key).toEqual(expectedKey);
    expect(mocks.getPolkadotSigner).toHaveBeenCalledWith(
      new Uint8Array(32).fill(7),
      "Sr25519",
      expect.any(Function),
    );
    expect(mocks.submitPreimageAsUser).toHaveBeenCalledWith(
      value,
      expect.objectContaining({
        publicKey: new Uint8Array(32).fill(7),
        type: "Sr25519",
      }),
    );

    const signer = mocks.submitPreimageAsUser.mock.calls[0]?.[1] as
      | { sign: (input: Uint8Array) => Promise<Uint8Array> | Uint8Array }
      | undefined;
    await expect(signer?.sign(new Uint8Array([8, 9]))).resolves.toEqual(
      new Uint8Array([8, 9, 42]),
    );
    expect(allowanceSigner.sign).toHaveBeenCalledWith(new Uint8Array([8, 9]));

    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toEqual(value);
  });

  it("propagates submit failures without caching the preimage", async () => {
    const { lookupPreimage, submitPreimage } = createPreimageAdapters("myapp");
    const value = new Uint8Array([5, 6, 7, 8]);
    const publicKey = new Uint8Array(32);
    publicKey.fill(9);
    const allowanceSigner = {
      publicKey,
      sign: vi.fn(async (input: Uint8Array) => input),
    };
    mocks.submitPreimageAsUser.mockRejectedValueOnce(
      new Error("Transaction timed out after 45000ms"),
    );

    await expect(submitPreimage(value, allowanceSigner)).rejects.toThrow(
      "Transaction timed out after 45000ms",
    );

    const iterator = lookupPreimage(fromHex(computePreimageKey(value)))[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toBeUndefined();
  });
});
